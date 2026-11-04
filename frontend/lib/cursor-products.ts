/**
 * Cursor spend by product (issue #65): Grok Bot, Bugbot, Agent/Chat.
 *
 * Cursor rows (one per person / day / model) carry the model, and the model
 * names identify the product: `grok-bot-*` (grok-bot-default,
 * grok-bot-automation, ...) is Grok Bot, `github_bugbot` is Bugbot, and every
 * other model (grok-4.7-high, default, claude-*, ...) is Agent/Chat. The daily
 * rollups keep model_name, so the split reads the same rollup rows as the
 * Cursor total (already narrowed to the period and the person / team filters)
 * and needs no extra query or migration. Slices are rounded with largest
 * remainders, so they always sum to the Cursor total to the cent.
 */

import { productNum, roundSplit, type ProductSlice, type ProductSplit } from "@/lib/product-breakdown"

export const CURSOR_SLUG = "cursor"

export const CURSOR_PRODUCTS = ["grok_bot", "bugbot", "agent_chat"] as const
export type CursorProduct = (typeof CURSOR_PRODUCTS)[number]

export const CURSOR_PRODUCT_LABEL: Record<CursorProduct, string> = {
  grok_bot: "Grok Bot",
  bugbot: "Bugbot",
  agent_chat: "Agent/Chat",
}

export type CursorProductSlice = ProductSlice<CursorProduct>
export type CursorProductSplit = ProductSplit<CursorProduct>

/** Product bucket for a Cursor model_name. */
export function cursorProductBucket(model: unknown): CursorProduct {
  if (typeof model !== "string") return "agent_chat"
  const m = model.trim().toLowerCase()
  if (m.startsWith("grok-bot-")) return "grok_bot"
  if (m === "github_bugbot") return "bugbot"
  return "agent_chat"
}

/** Split Cursor rollup rows (already the period's Cursor rows, filtered) by product. */
export function splitCursorByProduct(daily: { model_name: string; total_cost_usd: number | string }[]): CursorProductSplit {
  const exact: Record<CursorProduct, number> = { grok_bot: 0, bugbot: 0, agent_chat: 0 }
  let total = 0
  for (const r of daily) {
    const c = productNum(r.total_cost_usd)
    total += c
    exact[cursorProductBucket(r.model_name)] += c
  }
  return roundSplit(CURSOR_PRODUCTS, CURSOR_PRODUCT_LABEL, exact, total)
}
