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
 *
 * Issue #65: the Analytics API labels most chat `cowork` and
 * `chat_cowork_unified`, so those are Chat too. Small products (claude_design,
 * claude_tag, voice_mode, office_agent, claude_in_chrome, research,
 * code_review, ...) stay in Other, and the split lists the raw labels that
 * landed there (`labels` on the Other slice) so the card can show them.
 */

import { applyFilters, hasFilters, type DashboardFilters } from "@/lib/dashboard-filters"
import { resolveAttribution } from "@/lib/org/attribution"
import type { OrgIndex } from "@/lib/org/types"
import { productNum as num, roundSplit, type ProductSlice as Slice, type ProductSplit } from "@/lib/product-breakdown"

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
const CHAT_PRODUCTS = new Set(["claude_chat", "chat", "claude_ai", "chat_cowork_unified", "cowork"])

/** Label shown in Other's list for spend with no product label. */
export const UNLABELLED_PRODUCT = "(no product label)"

/** Normalised product label (lower case, "-"/" "/"." -> "_"), or null when there is none. */
export function normaliseProduct(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const p = raw.trim().toLowerCase().replace(/[-\s.]+/g, "_")
  return p === "" ? null : p
}

/** Product bucket for a raw metadata.group.product value; anything unlabelled or unknown is Other. */
export function productBucket(raw: unknown): ClaudeAiProduct {
  const p = normaliseProduct(raw)
  if (p === null) return "other"
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
  /** Normalised raw product label (null when unlabelled); listed under Other. */
  label?: string | null
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
      label: normaliseProduct(r.product),
    })
  }
  return out
}

export type ProductSlice = Slice<ClaudeAiProduct>

/** Always Claude Code, Chat, Other in that order; their costs sum to `total`. */
export type ClaudeAiProductSplit = ProductSplit<ClaudeAiProduct>

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
  // key -> Other's raw label -> raw cost, for the labels list.
  const otherLabels = new Map<string, Map<string, number>>()
  for (const r of productRows) {
    const k = key(r.date, r.model_name)
    const s = raw.get(k) ?? { claude_code: 0, chat: 0, other: 0 }
    s[r.product] += r.cost
    raw.set(k, s)
    if (r.product === "other") {
      const m = otherLabels.get(k) ?? new Map<string, number>()
      const l = r.label ?? UNLABELLED_PRODUCT
      m.set(l, (m.get(l) ?? 0) + r.cost)
      otherLabels.set(k, m)
    }
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
  // Other's labels, weighted by the rollup cost each contributes.
  const labelCost = new Map<string, number>()
  const addLabel = (l: string, c: number) => labelCost.set(l, (labelCost.get(l) ?? 0) + c)
  for (const [k, cost] of rolled) {
    const s = raw.get(k)
    const rawTotal = s ? s.claude_code + s.chat + s.other : 0
    if (!s || rawTotal === 0) {
      exact.other += cost
      if (cost !== 0) addLabel(UNLABELLED_PRODUCT, cost)
      continue
    }
    for (const p of CLAUDE_AI_PRODUCTS) exact[p] += (cost * s[p]) / rawTotal
    for (const [l, c] of otherLabels.get(k) ?? []) if (c !== 0) addLabel(l, (cost * c) / rawTotal)
  }

  const split = roundSplit(CLAUDE_AI_PRODUCTS, CLAUDE_AI_PRODUCT_LABEL, exact, total)
  const labels = [...labelCost.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([l]) => l)
  if (labels.length > 0) split.products = split.products.map((p) => (p.product === "other" ? { ...p, labels } : p))
  return split
}
