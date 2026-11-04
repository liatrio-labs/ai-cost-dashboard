/**
 * The budget-alert cron (issue #49): /api/cron/budget-alerts calls runBudgetAlerts.
 *
 * 1. Without migration 020 (no budgets table): nothing is computed, logged or
 *    sent; status "migration_020_not_applied".
 * 2. Live mode with no channel configured: nothing is sent or logged
 *    (status "no_channels"), so alerts still go out once one is configured.
 * 3. Otherwise each candidate (lib/budget-alerts.ts) is claimed by inserting
 *    its alert_log row first. A unique violation means it already went out
 *    (or, in dry-run, was already logged) this month: skipped. In live mode
 *    the claim is then sent; when every channel fails the claim is removed so
 *    the next run retries. Dry-run never calls fetch.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { fetchProviders, type SupabaseLike } from "@/lib/dashboard-data"
import { budgetWindowStart, computeBudgetStatuses } from "@/lib/budgets"
import { alertConfig, buildAlertCandidates, deliver, enabledChannels, type AlertCandidate, type AlertChannel, type AlertMode, type FetchLike, type EnvLike } from "@/lib/budget-alerts"
import { computeReviewInbox, reviewWindowStart } from "../review-inbox"
import { loadAttributedSince, loadBudgets } from "./budgets"
import { loadOrg } from "./repo"
import { isMissingTable, loadDecisions } from "./review"

export type AlertRunStatus = "migration_020_not_applied" | "no_channels" | "ok"

export interface AlertRunResult {
  status: AlertRunStatus
  mode: AlertMode
  channels: AlertChannel[]
  candidates: number
  /** Sent (live) or logged (dry-run) this run. */
  sent: number
  /** Already sent / logged this month. */
  deduped: number
  failed: number
  alerts: { subject: string; period: string; kinds: string[]; result: "sent" | "logged" | "deduped" | "failed"; channels: AlertChannel[] }[]
}

export interface AlertRunOptions {
  now?: Date
  env?: EnvLike
  fetchImpl?: FetchLike
}

export async function runBudgetAlerts(admin: SupabaseClient, opts: AlertRunOptions = {}): Promise<AlertRunResult> {
  const now = opts.now ?? new Date()
  const config = alertConfig(opts.env ?? process.env)
  const mode = config.summary.mode
  const channels = enabledChannels(config.summary)
  const result: AlertRunResult = { status: "ok", mode, channels, candidates: 0, sent: 0, deduped: 0, failed: 0, alerts: [] }

  const budgets = await loadBudgets(admin)
  if (budgets === null) return { ...result, status: "migration_020_not_applied" }

  const [org, providers, decisions] = await Promise.all([loadOrg(admin), fetchProviders(admin as unknown as SupabaseLike), loadDecisions(admin)])
  const a = budgetWindowStart(providers, now)
  const b = reviewWindowStart(now)
  const rows = await loadAttributedSince(admin, a < b ? a : b)
  const statuses = computeBudgetStatuses({ rows, org, providers, budgets, now })
  const inbox = computeReviewInbox({ rows, org, providers, decisions: decisions ?? [], now })
  const candidates = buildAlertCandidates(
    statuses,
    inbox.items.filter((i) => i.kind === "person_spike")
  )
  result.candidates = candidates.length
  if (!candidates.length) return result
  if (mode === "live" && !channels.length) return { ...result, status: "no_channels" }

  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  for (const c of candidates) {
    const claim = await claimAlert(admin, c, mode === "dry_run", now)
    if (claim === "deduped") {
      result.deduped++
      result.alerts.push({ subject: c.subject, period: c.period, kinds: c.kinds, result: "deduped", channels: [] })
      continue
    }
    if (mode === "dry_run") {
      result.sent++
      result.alerts.push({ subject: c.subject, period: c.period, kinds: c.kinds, result: "logged", channels: [] })
      continue
    }
    const out = await deliver(config, c, fetchImpl)
    if (out.sent.length) {
      await admin.from("alert_log").update({ channels: out.sent }).eq("id", claim)
      result.sent++
      result.alerts.push({ subject: c.subject, period: c.period, kinds: c.kinds, result: "sent", channels: out.sent })
    } else {
      // Nothing went out: release the claim so the next run retries.
      await admin.from("alert_log").delete().eq("id", claim)
      result.failed++
      result.alerts.push({ subject: c.subject, period: c.period, kinds: c.kinds, result: "failed", channels: [] })
    }
    for (const f of out.failed) console.warn(`[budget-alerts] ${f.channel} failed for ${c.subject} ${c.period}: ${f.error}`)
  }
  return result
}

/** Insert the alert_log row. Returns its id, or "deduped" when this subject / month already has one. */
async function claimAlert(admin: SupabaseClient, c: AlertCandidate, dryRun: boolean, now: Date): Promise<string | "deduped"> {
  const res = await admin
    .from("alert_log")
    .insert({
      subject: c.subject,
      period: c.period,
      kinds: c.kinds,
      dry_run: dryRun,
      channels: [],
      amount: c.amount,
      budget_usd: c.budgetUsd,
      message: c.message,
      sent_at: now.toISOString(),
    })
    .select("id")
    .single()
  if (res.error?.code === "23505") return "deduped"
  if (isMissingTable(res.error)) throw new Error("alert_log missing: migration 020 is partially applied")
  if (res.error) throw new Error(`alert_log insert failed: ${res.error.message}`)
  return (res.data as { id: string }).id
}
