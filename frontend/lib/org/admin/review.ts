/**
 * Data access for the needs-review inbox (issue #44): reads the rows, org,
 * providers and review_items decisions for lib/org/review-inbox.ts, and
 * records Acknowledge / Assign decisions. review_items is migration 018:
 * without it the inbox is still computed (no decisions) and writes return a
 * clear "migration 018 not applied" 409 instead of a 500.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"
import { ATTRIBUTED_COLUMNS, fetchAllPaged, fetchProviders, type SupabaseLike } from "@/lib/dashboard-data"
import { computeReviewInbox, REVIEW_KINDS, REVIEW_STATUSES, reviewWindowStart, type ReviewDecision, type ReviewInbox } from "../review-inbox"
import type { AttributedDailyRow } from "../types"
import { DbError, HttpError } from "./http"
import { loadOrg } from "./repo"

export const MIGRATION_018_NOTICE =
  "Migration 018 not applied: the inbox is computed live, but Acknowledge and notes are unavailable until database/migrations/018_review_inbox.sql is applied."

export const DECISION_COLUMNS = "kind, subject, period, amount, status, note, acknowledged_by, acknowledged_at"

/** True for "table does not exist" from Postgres (42P01) or PostgREST (PGRST205, schema cache). */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  return (
    !!error &&
    (error.code === "42P01" ||
      error.code === "PGRST205" ||
      /relation .* does not exist|could not find the table/i.test(error.message ?? ""))
  )
}

function migrationNotApplied(): never {
  throw new HttpError(409, MIGRATION_018_NOTICE, { code: "migration_018_not_applied" })
}

/** review_items rows, or null when the table doesn't exist (018 not applied). */
export async function loadDecisions(admin: SupabaseClient): Promise<ReviewDecision[] | null> {
  const res = await admin.from("review_items").select(DECISION_COLUMNS)
  if (isMissingTable(res.error)) return null
  if (res.error) throw new DbError(res.error.code, res.error.message)
  return (res.data ?? []) as unknown as ReviewDecision[]
}

export interface ReviewInboxResponse extends ReviewInbox {
  /** review_items exists (migration 018): Acknowledge and notes work. */
  decisions_available: boolean
  /** Set when 018 isn't applied. */
  notice: string | null
}

export async function loadReviewInbox(admin: SupabaseClient, now = new Date()): Promise<ReviewInboxResponse> {
  const db = admin as unknown as SupabaseLike
  const start = reviewWindowStart(now)
  const [org, providers, rows, decisions] = await Promise.all([
    loadOrg(admin),
    fetchProviders(db),
    fetchAllPaged<AttributedDailyRow>(db, "cost_records_daily_attributed", ATTRIBUTED_COLUMNS, (q) => q.gte("date", start)),
    loadDecisions(admin),
  ])
  const inbox = computeReviewInbox({ rows, org, providers, decisions: decisions ?? [], now })
  return { ...inbox, decisions_available: decisions !== null, notice: decisions === null ? MIGRATION_018_NOTICE : null }
}

export const reviewDecisionSchema = z.strictObject({
  kind: z.enum(REVIEW_KINDS),
  subject: z.string().trim().min(1).max(500),
  period: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/, { error: "period must be YYYY-MM or YYYY-MM-DD" }),
  amount: z.number().finite().min(0),
  status: z.enum(REVIEW_STATUSES).default("acknowledged"),
  note: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .transform((v) => v || null),
})
export type ReviewDecisionInput = z.infer<typeof reviewDecisionSchema>

/** Record (or replace) the decision for one item. Throws a 409 when migration 018 isn't applied. */
export async function saveDecision(admin: SupabaseClient, input: ReviewDecisionInput, by: string, now = new Date()): Promise<ReviewDecision> {
  const row = {
    kind: input.kind,
    subject: input.subject,
    period: input.period,
    amount: Math.round(input.amount * 100) / 100,
    status: input.status,
    note: input.note,
    acknowledged_by: by,
    acknowledged_at: now.toISOString(),
  }
  const match = () => admin.from("review_items").select("id").eq("kind", row.kind).eq("subject", row.subject).eq("period", row.period)
  const found = await match()
  if (isMissingTable(found.error)) migrationNotApplied()
  if (found.error) throw new DbError(found.error.code, found.error.message)
  const update = async (id: string) => {
    const res = await admin.from("review_items").update({ ...row, updated_at: row.acknowledged_at }).eq("id", id).select(DECISION_COLUMNS).single()
    if (res.error) throw new DbError(res.error.code, res.error.message)
    return res.data as unknown as ReviewDecision
  }
  const existing = (found.data as { id: string }[] | null)?.[0]
  if (existing) return update(existing.id)
  const ins = await admin.from("review_items").insert(row).select(DECISION_COLUMNS).single()
  if (isMissingTable(ins.error)) migrationNotApplied()
  if (ins.error?.code === "23505") {
    // Someone else recorded it first: replace theirs.
    const again = await match()
    const id = (again.data as { id: string }[] | null)?.[0]?.id
    if (id) return update(id)
  }
  if (ins.error) throw new DbError(ins.error.code, ins.error.message)
  return ins.data as unknown as ReviewDecision
}
