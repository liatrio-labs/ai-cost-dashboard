/**
 * Claude.ai spend by product (issue #48): Claude Code, Chat, Other.
 *
 * The claude-ai collector stores the Analytics API's product on every record
 * (cost_records.metadata.group.product, lib/collectors/claude-ai.ts). The
 * daily rollups (cost_records_daily, cost_records_daily_attributed) group by
 * model, not product, so no migration is needed: the routes read the product
 * for the period straight from cost_records (a JSON path select) and this
 * module splits the rollup's Claude.ai rows by it.
 *
 * Totals never change: each rollup row (date x model, plus the attribution
 * columns when filtered) is divided between products in proportion to the raw
 * records with the same key. A rollup row with no matching raw spend (e.g. the
 * materialized view and cost_records briefly disagree) goes to Other, and the
 * slices are rounded with largest remainders, so Claude Code + Chat + Other
 * always equals the Claude.ai total to the cent. Records without a product
 * label (the legacy cost_report fallback, or a null product) are Other.
 */

import { applyFilters, hasFilters, type DashboardFilters } from "@/lib/dashboard-filters"
import { resolveAttribution } from "@/lib/org/attribution"
import type { OrgIndex } from "@/lib/org/types"

export const CLAUDE_AI_SLUG = "claude-ai"

export const CLAUDE_AI_PRODUCTS = ["claude_code", "chat", "other"] as const
export type ClaudeAiProduct = (typeof CLAUDE_AI_PRODUCTS)[number]

export const CLAUDE_AI_PRODUCT_LABEL: Record<ClaudeAiProduct, string> = {
  claude_code: "Claude Code",
  chat: "Chat",
  other: "Other",
}

// Analytics API product values, normalised (lower case, "-" and " " -> "_").
const CODE_PRODUCTS = new Set(["claude_code"])
const CHAT_PRODUCTS = new Set(["claude_chat", "chat", "claude_ai"])

/** Product bucket for a raw metadata.group.product value; anything unlabelled or unknown is Other. */
export function productBucket(raw: unknown): ClaudeAiProduct {
  if (typeof raw !== "string") return "other"
  const p = raw.trim().toLowerCase().replace(/[-\s.]+/g, "_")
  if (CODE_PRODUCTS.has(p)) return "claude_code"
  if (CHAT_PRODUCTS.has(p)) return "chat"
  return "other"
}

/**
 * A cost_records row as the routes select it:
 * provider_id, timestamp, model_name, cost_usd,
 * product:metadata->group->>product, attribution:metadata->attribution.
 */
export interface ProductCostRow {
  provider_id: string
  timestamp: string
  model_name: string
  cost_usd: number | string | null
  product?: string | null
  attribution?: unknown
}

/** Columns for an unfiltered split; filtered views add PRODUCT_ATTRIBUTION_COLUMN. */
export const PRODUCT_COST_COLUMNS = "provider_id, timestamp, model_name, cost_usd, product:metadata->group->>product"
export const PRODUCT_ATTRIBUTION_COLUMN = "attribution:metadata->attribution"

/** A raw record reduced to what the split needs (UTC date, like the rollups' DATE(timestamp)). */
export interface ProductDayRow {
  date: string
  model_name: string
  product: ClaudeAiProduct
  cost: number
}

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Reduce raw rows to ProductDayRows. With org filters, each row is resolved
 * like cost_records_daily_attributed (lib/org/attribution.ts) and kept only
 * when it matches, so it lines up with the filtered rollup rows.
 */
export function toProductDayRows(
  rows: ProductCostRow[],
  opts: { filters?: DashboardFilters; index?: OrgIndex | null; providerId?: string | null } = {}
): ProductDayRow[] {
  const filters = opts.filters ?? {}
  const filtering = hasFilters(filters)
  const out: ProductDayRow[] = []
  for (const r of rows) {
    const t = Date.parse(r.timestamp)
    if (Number.isNaN(t)) continue
    if (filtering) {
      if (!opts.index) continue
      const resolved = resolveAttribution({ provider_id: r.provider_id, metadata: { attribution: r.attribution } }, opts.index)
      if (applyFilters([{ provider_id: r.provider_id, ...resolved }], filters, opts.providerId ?? null).length === 0) continue
    }
    out.push({
      date: new Date(t).toISOString().slice(0, 10),
      model_name: r.model_name,
      product: productBucket(r.product),
      cost: num(r.cost_usd),
    })
  }
  return out
}

export interface ProductSlice {
  product: ClaudeAiProduct
  label: string
  cost: number
}

export interface ClaudeAiProductSplit {
  /** Claude.ai total for the rows split (rounded to cents, as the tool row shows it). */
  total: number
  /** Always Claude Code, Chat, Other in that order; their costs sum to `total`. */
  products: ProductSlice[]
}

const key = (date: string, model: string) => `${date}\u0000${model}`

/**
 * Split Claude.ai rollup rows by product. `daily` must already be the
 * Claude.ai rows for the period (and filters); `productRows` the matching raw
 * records (same period and filters).
 */
export function splitClaudeAiByProduct(
  daily: { date: string; model_name: string; total_cost_usd: number | string }[],
  productRows: ProductDayRow[]
): ClaudeAiProductSplit {
  const raw = new Map<string, Record<ClaudeAiProduct, number>>()
  for (const r of productRows) {
    const k = key(r.date, r.model_name)
    const s = raw.get(k) ?? { claude_code: 0, chat: 0, other: 0 }
    s[r.product] += r.cost
    raw.set(k, s)
  }

  // The rollup's cost per key (several attributed rows can share one).
  const rolled = new Map<string, number>()
  let total = 0
  for (const r of daily) {
    const c = num(r.total_cost_usd)
    total += c
    const k = key(r.date, r.model_name)
    rolled.set(k, (rolled.get(k) ?? 0) + c)
  }

  const exact: Record<ClaudeAiProduct, number> = { claude_code: 0, chat: 0, other: 0 }
  for (const [k, cost] of rolled) {
    const s = raw.get(k)
    const rawTotal = s ? s.claude_code + s.chat + s.other : 0
    if (!s || rawTotal === 0) {
      exact.other += cost
      continue
    }
    for (const p of CLAUDE_AI_PRODUCTS) exact[p] += (cost * s[p]) / rawTotal
  }

  const totalCents = Math.round(total * 100)
  const cents = allocateCents(totalCents, CLAUDE_AI_PRODUCTS.map((p) => exact[p] * 100))
  return {
    total: totalCents / 100,
    products: CLAUDE_AI_PRODUCTS.map((p, i) => ({ product: p, label: CLAUDE_AI_PRODUCT_LABEL[p], cost: cents[i] / 100 })),
  }
}

/** Round `parts` to integers that sum to `target` (largest remainder). */
function allocateCents(target: number, parts: number[]): number[] {
  const floors = parts.map((p) => Math.floor(p))
  let rest = target - floors.reduce((a, b) => a + b, 0)
  const order = parts.map((p, i) => ({ i, frac: p - floors[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i)
  const out = [...floors]
  // rest is within [-n, n] for in-range inputs; loop handles any sign.
  for (let j = 0; rest !== 0; j = (j + 1) % out.length) {
    const step = rest > 0 ? 1 : -1
    out[order[j].i] += step
    rest -= step
  }
  return out
}
