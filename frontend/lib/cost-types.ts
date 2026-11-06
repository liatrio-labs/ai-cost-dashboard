/**
 * Issue #88: what kind of cost a rollup row is, and user-facing provider names.
 *
 * Model charts must not treat licenses as models. A row is a seat / license /
 * flat-fee cost (not model usage) when its model_name is one of the bill
 * models written by manual entries, recurring costs (#59), Cursor seat fees
 * (026) or invoice adjustments (#75), or when it comes from a monthly-seat
 * provider (ChatGPT Business, Claude Ultra). Everything else is model usage.
 *
 * Cursor amounts come in three distinct cost types that must never be added
 * together or labelled as each other:
 *   - seats: per-person seat fees (model "cursor seats"), calendar month;
 *   - calendar on-demand: usage events in the calendar month (cost_records);
 *   - billing-cycle on-demand: /teams/spend snapshot for the Cursor cycle
 *     (cursor_spend_cycles), a different window, shown on its own.
 */

import {
  CURSOR_SEAT_MODEL,
  INVOICE_ADJUSTMENT_MODEL,
  MONTHLY_SEAT_PROVIDERS,
  RECURRING_MODEL,
  RECURRING_SEAT_MODEL,
  SEAT_MODEL,
} from "@/lib/projection"
import { splitHeaderLabel } from "@/lib/header-label"

/** Manual entries that are not seat-based use this model name. */
export const MANUAL_MODEL = "manual"

const SEAT_MODELS: ReadonlySet<string> = new Set([SEAT_MODEL, RECURRING_SEAT_MODEL, CURSOR_SEAT_MODEL])
const FLAT_FEE_MODELS: ReadonlySet<string> = new Set([RECURRING_MODEL, MANUAL_MODEL])

export type LicenseKind = "seats" | "subscription" | "invoice_adjustment"

/** The kind of license / bill a row is, or null for model usage. */
export function licenseKind(modelName: string | null | undefined, providerSlug: string | null | undefined): LicenseKind | null {
  const m = (modelName ?? "").trim().toLowerCase()
  if (SEAT_MODELS.has(m)) return "seats"
  if (m === INVOICE_ADJUSTMENT_MODEL) return "invoice_adjustment"
  if (providerSlug && (MONTHLY_SEAT_PROVIDERS as readonly string[]).includes(providerSlug)) return "seats"
  if (FLAT_FEE_MODELS.has(m)) return "subscription"
  return null
}

export function isLicenseRow(modelName: string | null | undefined, providerSlug: string | null | undefined): boolean {
  return licenseKind(modelName, providerSlug) !== null
}

/** "Cursor (Admin API)" -> "Cursor": the product name without its collection-method suffix. */
export function shortProviderName(name: string): string {
  return splitHeaderLabel(name).primary
}

const KIND_SUFFIX: Record<LicenseKind, string> = {
  seats: "seats",
  subscription: "subscription",
  invoice_adjustment: "invoice adjustment",
}

/** "Claude Ultra seats", "Cursor seats", "Lovable subscription". */
export function licenseLabel(kind: LicenseKind, providerName: string): string {
  return `${shortProviderName(providerName)} ${KIND_SUFFIX[kind]}`
}

// ---------------------------------------------------------------------------
// Claude Ultra naming (#26 renamed Claude Max to Claude Ultra; slug stays claude-max)
// ---------------------------------------------------------------------------

export const CLAUDE_ULTRA_SLUG = "claude-max"
export const CLAUDE_ULTRA_NAME = "Claude Ultra"

/** The provider name shown to users. Claude Max is always shown as Claude Ultra. */
export function userFacingProviderName(slug: string, displayName: string | null | undefined): string {
  const name = displayName || slug
  if (slug === CLAUDE_ULTRA_SLUG && (/claude[\s-]*max/i.test(name) || name === slug)) return CLAUDE_ULTRA_NAME
  return name
}

/** A provider description with the old product name replaced, so it agrees with the provider name. */
export function userFacingDescription(slug: string, description: string | null | undefined): string {
  const d = description ?? ""
  return slug === CLAUDE_ULTRA_SLUG ? d.replace(/claude[\s-]*max/gi, CLAUDE_ULTRA_NAME) : d
}

// ---------------------------------------------------------------------------
// Cursor seat composition (issue #88): from stored assignments' seat rows and
// stored rates, never an assumed flat rate.
// ---------------------------------------------------------------------------

export interface SeatCompositionPart {
  /** "standard" | "premium" | "free", or "other" for an amount matching no stored rate (e.g. scaled to an invoice). */
  type: string
  label: string
  count: number
  rate: number
  total: number
}

export interface SeatComposition {
  parts: SeatCompositionPart[]
  total: number
  /** "12 Standard × $40.00 + 3 Premium × $60.00 = $660.00; Free seats bill $0". */
  text: string
}

const SEAT_LABEL: Record<string, string> = { standard: "Standard", premium: "Premium", free: "Free" }
const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n)
const r2 = (n: number) => Math.round(n * 100) / 100

/**
 * Seat composition of Cursor seat rows (one row per billed person per month).
 * `ratesAt(month)` gives the stored rate per seat type for that month. A row
 * whose amount matches exactly one rate is counted under that type; other
 * amounts (an invoice-scaled month) are grouped as "other" at their amount.
 */
export function cursorSeatComposition(
  rows: { date: string; total_cost_usd: number | string }[],
  ratesAt: ((month: string) => Record<string, number>) | null,
  opts: { seatMonths?: boolean } = {}
): SeatComposition | null {
  if (!rows.length) return null
  const parts = new Map<string, SeatCompositionPart>()
  let freeRate: number | null = null
  for (const r of rows) {
    const cost = r2(Number(r.total_cost_usd) || 0)
    const rates = ratesAt ? ratesAt(r.date.slice(0, 7)) : {}
    if (rates.free !== undefined) freeRate = rates.free
    const matches = Object.entries(rates).filter(([, v]) => r2(v) === cost && v > 0)
    const type = matches.length === 1 ? matches[0][0] : "other"
    const key = `${type}:${cost}`
    const p = parts.get(key) ?? { type, label: SEAT_LABEL[type] ?? "Other", count: 0, rate: cost, total: 0 }
    p.count += 1
    p.total = r2(p.total + cost)
    parts.set(key, p)
  }
  const order = ["standard", "premium", "other"]
  const list = [...parts.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || b.rate - a.rate)
  const total = r2(list.reduce((s, p) => s + p.total, 0))
  const unit = opts.seatMonths ? "seat-month" : "seat"
  const piece = (p: SeatCompositionPart) =>
    p.type === "other" ? `${p.count} other ${unit}${p.count === 1 ? "" : "s"} × ${usd(p.rate)}` : `${p.count} ${p.label} × ${usd(p.rate)}`
  const free = freeRate !== null && freeRate === 0 ? "; Free seats bill $0" : ""
  return { parts: list, total, text: `${list.map(piece).join(" + ")} = ${usd(total)}${free}` }
}
