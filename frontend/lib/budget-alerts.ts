/**
 * Budget and spike alerts (issue #49). Pure apart from `deliver`, which takes
 * an injected fetch, so tests never reach Slack or email.
 *
 * Configuration is environment variables only; this file knows their names,
 * never their values, and nothing here logs or returns a value:
 *
 *   BUDGET_ALERTS_MODE              "live" sends; anything else (or unset) is
 *                                   dry-run: alerts are computed and logged to
 *                                   alert_log with dry_run = true, nothing is sent
 *   BUDGET_ALERT_SLACK_WEBHOOK_URL  Slack incoming-webhook URL
 *   BUDGET_ALERT_EMAIL_TO           comma-separated recipients
 *   BUDGET_ALERT_EMAIL_FROM         sender address (a verified Resend domain)
 *   RESEND_API_KEY                  Resend API key, used for email
 *
 * Slack is on when its webhook is set; email when TO, FROM and RESEND_API_KEY
 * are all set. With neither, nothing is sent and nothing is logged in live mode.
 *
 * What alerts: a budget whose current month, projected with #39, is over its
 * monthly budget (projected_overrun), and a person spike from the #44 inbox
 * (spike). One alert per subject per month: both reasons for the same
 * subject and month go in one message, and alert_log (UNIQUE subject, period,
 * dry_run) stops a second one.
 */

import type { BudgetStatus } from "@/lib/budgets"
import type { ReviewItem } from "@/lib/org/review-inbox"

export const ALERT_ENV = {
  mode: "BUDGET_ALERTS_MODE",
  slackWebhook: "BUDGET_ALERT_SLACK_WEBHOOK_URL",
  emailTo: "BUDGET_ALERT_EMAIL_TO",
  emailFrom: "BUDGET_ALERT_EMAIL_FROM",
  resendKey: "RESEND_API_KEY",
} as const

export const RESEND_ENDPOINT = "https://api.resend.com/emails"

/** process.env, or a plain object in tests. */
export type EnvLike = Record<string, string | undefined>

export type AlertMode = "dry_run" | "live"
export type AlertChannel = "slack" | "email"
export type AlertKind = "projected_overrun" | "spike"

/** Safe to return to the browser: names and booleans only. */
export interface AlertConfigSummary {
  mode: AlertMode
  channels: Record<AlertChannel, boolean>
  env: typeof ALERT_ENV
}

interface AlertSecrets {
  slackWebhook: string | null
  email: { to: string[]; from: string; apiKey: string } | null
}

export interface AlertConfig {
  summary: AlertConfigSummary
  /** Only used by deliver(); never serialized. */
  secrets: AlertSecrets
}

const val = (env: EnvLike, name: string) => {
  const v = env[name]?.trim()
  return v ? v : null
}

export function alertConfig(env: EnvLike = process.env): AlertConfig {
  const mode: AlertMode = val(env, ALERT_ENV.mode)?.toLowerCase() === "live" ? "live" : "dry_run"
  const slackWebhook = val(env, ALERT_ENV.slackWebhook)
  const to = (val(env, ALERT_ENV.emailTo) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const from = val(env, ALERT_ENV.emailFrom)
  const apiKey = val(env, ALERT_ENV.resendKey)
  const email = to.length && from && apiKey ? { to, from, apiKey } : null
  const secrets: AlertSecrets = { slackWebhook, email }
  const summary: AlertConfigSummary = { mode, channels: { slack: !!slackWebhook, email: !!email }, env: ALERT_ENV }
  // Keep secrets off JSON.stringify / console output of the config object.
  const config = { summary } as AlertConfig
  Object.defineProperty(config, "secrets", { value: secrets, enumerable: false })
  return config
}

export const enabledChannels = (c: AlertConfigSummary): AlertChannel[] => (["slack", "email"] as const).filter((ch) => c.channels[ch])

export interface AlertCandidate {
  /** person:<id> | team:<id> | project:<id> */
  subject: string
  /** YYYY-MM */
  period: string
  kinds: AlertKind[]
  label: string
  /** Projected (or spike) amount. */
  amount: number
  budgetUsd: number | null
  message: string
}

const usd = (n: number) => `$${(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * One candidate per (subject, month) from over-budget statuses and person
 * spike items. Deleted subjects and budgets under their projection are skipped.
 */
export function buildAlertCandidates(statuses: BudgetStatus[], spikes: ReviewItem[]): AlertCandidate[] {
  type Acc = { subject: string; period: string; label: string; lines: string[]; kinds: Set<AlertKind>; amount: number; budgetUsd: number | null }
  const acc = new Map<string, Acc>()
  const get = (subject: string, period: string, label: string) => {
    const k = `${subject}\u0000${period}`
    let a = acc.get(k)
    if (!a) acc.set(k, (a = { subject, period, label, lines: [], kinds: new Set(), amount: 0, budgetUsd: null }))
    return a
  }
  for (const s of statuses) {
    if (!s.projectedOver || !s.subjectExists) continue
    const a = get(s.subject, s.month, `${s.budget.scope} ${s.label}`)
    a.kinds.add("projected_overrun")
    a.amount = Math.max(a.amount, s.projected)
    a.budgetUsd = s.budgetUsd
    a.lines.push(
      `Projected ${usd(s.projected)} for ${s.month} against a ${usd(s.budgetUsd)} budget (${Math.round(s.ratio * 100)}%; actual so far ${usd(s.actual)})${s.state === "over" ? ", already over" : ""}.`
    )
  }
  for (const it of spikes) {
    if (it.kind !== "person_spike") continue
    const a = get(`person:${it.subject}`, it.period, `person ${it.label}`)
    a.kinds.add("spike")
    a.amount = Math.max(a.amount, it.amount)
    a.lines.push(
      `Spend spike: ${usd(it.amount)}${it.projected ? " projected" : ""} for ${it.period}, ${it.ratio !== null ? `${it.ratio}x the ${usd(it.previousAmount ?? 0)} of the month before` : "no spend the month before"}.`
    )
  }
  return [...acc.values()]
    .map((a) => ({
      subject: a.subject,
      period: a.period,
      kinds: (["projected_overrun", "spike"] as const).filter((k) => a.kinds.has(k)),
      label: a.label,
      amount: Math.round(a.amount * 100) / 100,
      budgetUsd: a.budgetUsd,
      message: `AI spend alert: ${a.label}\n${a.lines.join("\n")}`,
    }))
    .sort((x, y) => x.subject.localeCompare(y.subject) || x.period.localeCompare(y.period))
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>

/** Send one alert to each enabled channel. Returns the channels that accepted it. Errors never include URLs or keys. */
export async function deliver(
  config: AlertConfig,
  alert: AlertCandidate,
  fetchImpl: FetchLike
): Promise<{ sent: AlertChannel[]; failed: { channel: AlertChannel; error: string }[] }> {
  const sent: AlertChannel[] = []
  const failed: { channel: AlertChannel; error: string }[] = []
  const attempt = async (channel: AlertChannel, fn: () => Promise<{ ok: boolean; status: number }>) => {
    try {
      const res = await fn()
      if (res.ok) sent.push(channel)
      else failed.push({ channel, error: `HTTP ${res.status}` })
    } catch (e) {
      failed.push({ channel, error: e instanceof Error ? e.name : "error" })
    }
  }
  const { slackWebhook, email } = config.secrets
  if (slackWebhook) {
    await attempt("slack", () =>
      fetchImpl(slackWebhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: alert.message }) })
    )
  }
  if (email) {
    await attempt("email", () =>
      fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${email.apiKey}` },
        body: JSON.stringify({ from: email.from, to: email.to, subject: `AI spend alert: ${alert.label} (${alert.period})`, text: alert.message }),
      })
    )
  }
  return { sent, failed }
}
