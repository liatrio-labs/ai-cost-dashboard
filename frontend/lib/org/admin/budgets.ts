/**
 * Data access for monthly budgets (issue #49): the budgets table (migration
 * 020), the rows / org / providers lib/budgets.ts needs, and saving and
 * deleting budgets. Without 020 reads return null (callers show "migration
 * 020 not applied") and writes are a 409 instead of a 500.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { ATTRIBUTED_COLUMNS, fetchAllPaged, fetchInvoicePlan, fetchProviders, type SupabaseLike } from "@/lib/dashboard-data"
import { applyInvoicePlan } from "@/lib/invoice-overrides"
import { BUDGET_SCOPES, budgetWindowStart, computeBudgetStatuses, type Budget, type BudgetStatus } from "@/lib/budgets"
import { alertConfig, type AlertConfigSummary, type EnvLike } from "@/lib/budget-alerts"
import type { AttributedDailyRow } from "../types"
import { DbError, HttpError } from "./http"
import { loadOrg } from "./repo"
import { isMissingTable } from "./review"
import type { OrgSnapshot } from "./schemas"

export const MIGRATION_020_NOTICE =
  "Migration 020 not applied: budgets, projected-over-budget flags and alerts are unavailable until database/migrations/020_budgets.sql is applied."

export const BUDGET_COLUMNS = "id, scope, subject_id, monthly_usd, note, created_by, updated_by, updated_at"

function migrationNotApplied(): never {
  throw new HttpError(409, MIGRATION_020_NOTICE, { code: "migration_020_not_applied" })
}

/** budgets rows, or null when the table doesn't exist (020 not applied). */
export async function loadBudgets(admin: SupabaseClient): Promise<Budget[] | null> {
  const res = await admin.from("budgets").select(BUDGET_COLUMNS)
  if (isMissingTable(res.error)) return null
  if (res.error) throw new DbError(res.error.code, res.error.message)
  return (res.data ?? []) as unknown as Budget[]
}

/**
 * Attributed rows from `start` through today, with invoice actuals applied
 * (issue #75): an overridden provider-month counts its invoiced amount, so
 * budgets, projections and spike alerts read the same totals as the
 * dashboard. No change without migration 024.
 */
export async function loadAttributedSince(admin: SupabaseClient, start: string): Promise<AttributedDailyRow[]> {
  const db = admin as unknown as SupabaseLike
  const [rows, plan] = await Promise.all([
    fetchAllPaged<AttributedDailyRow>(db, "cost_records_daily_attributed", ATTRIBUTED_COLUMNS, (q) => q.gte("date", start)),
    fetchInvoicePlan(db),
  ])
  return applyInvoicePlan(rows, plan).filter((r) => r.date >= start)
}

export interface BudgetsResponse {
  /** budgets exists (migration 020). */
  available: boolean
  /** Set when 020 isn't applied. */
  notice: string | null
  month: string
  statuses: BudgetStatus[]
  /** Alert settings: mode and which env var names are set. Never values. */
  alerts: AlertConfigSummary
}

/** Budgets with this month's projection. Without 020: an empty list and the notice (no row reads). */
export async function loadBudgetsResponse(admin: SupabaseClient, now = new Date(), env: EnvLike = process.env): Promise<BudgetsResponse> {
  const month = now.toISOString().slice(0, 7)
  const alerts = alertConfig(env).summary
  const budgets = await loadBudgets(admin)
  if (budgets === null) return { available: false, notice: MIGRATION_020_NOTICE, month, statuses: [], alerts }
  if (!budgets.length) return { available: true, notice: null, month, statuses: [], alerts }
  const [org, providers] = await Promise.all([loadOrg(admin), fetchProviders(admin as unknown as SupabaseLike)])
  const rows = await loadAttributedSince(admin, budgetWindowStart(providers, now))
  return { available: true, notice: null, month, statuses: computeBudgetStatuses({ rows, org, providers, budgets, now }), alerts }
}

export const budgetInputSchema = z.strictObject({
  scope: z.enum(BUDGET_SCOPES),
  subject_id: z.string().trim().min(1).max(100),
  monthly_usd: z.number().finite().positive({ error: "monthly_usd must be greater than 0" }).max(1e11),
  note: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .transform((v) => v || null),
})
export type BudgetInput = z.infer<typeof budgetInputSchema>

function subjectExists(org: OrgSnapshot, input: Pick<BudgetInput, "scope" | "subject_id">): boolean {
  const list = input.scope === "person" ? org.people : input.scope === "team" ? org.teams : org.projects
  return list.some((x) => x.id === input.subject_id)
}

/** Create or replace the budget for (scope, subject). 400 for an unknown subject, 409 without 020. */
export async function saveBudget(admin: SupabaseClient, input: BudgetInput, by: string, now = new Date()): Promise<Budget> {
  const found = await admin.from("budgets").select("id").eq("scope", input.scope).eq("subject_id", input.subject_id)
  if (isMissingTable(found.error)) migrationNotApplied()
  if (found.error) throw new DbError(found.error.code, found.error.message)
  const org = await loadOrg(admin)
  if (!subjectExists(org, input)) throw new HttpError(400, `Unknown ${input.scope}: ${input.subject_id}`)
  const row = { monthly_usd: Math.round(input.monthly_usd * 100) / 100, note: input.note, updated_by: by, updated_at: now.toISOString() }
  const update = async (id: string) => {
    const res = await admin.from("budgets").update(row).eq("id", id).select(BUDGET_COLUMNS).single()
    if (res.error) throw new DbError(res.error.code, res.error.message)
    return res.data as unknown as Budget
  }
  const existing = (found.data as { id: string }[] | null)?.[0]
  if (existing) return update(existing.id)
  const ins = await admin
    .from("budgets")
    .insert({ ...row, scope: input.scope, subject_id: input.subject_id, created_by: by })
    .select(BUDGET_COLUMNS)
    .single()
  if (ins.error?.code === "23505") {
    // Saved concurrently: replace it.
    const again = await admin.from("budgets").select("id").eq("scope", input.scope).eq("subject_id", input.subject_id)
    const id = (again.data as { id: string }[] | null)?.[0]?.id
    if (id) return update(id)
  }
  if (isMissingTable(ins.error)) migrationNotApplied()
  if (ins.error) throw new DbError(ins.error.code, ins.error.message)
  return ins.data as unknown as Budget
}

/** Delete one budget. 404 when it doesn't exist, 409 without 020. */
export async function deleteBudget(admin: SupabaseClient, id: string): Promise<void> {
  const res = await admin.from("budgets").delete().eq("id", id).select("id")
  if (isMissingTable(res.error)) migrationNotApplied()
  // 22P02: not a UUID, so no such budget.
  if (res.error?.code === "22P02") throw new HttpError(404, "Budget not found")
  if (res.error) throw new DbError(res.error.code, res.error.message)
  if (!((res.data as unknown[] | null) ?? []).length) throw new HttpError(404, "Budget not found")
}
