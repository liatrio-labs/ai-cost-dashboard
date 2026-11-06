"use client"

/**
 * Provider "by product" cards (issue #48 Claude.ai, issue #65 Cursor), built on
 * the shared ProductBreakdownCard (components/product-breakdown.tsx).
 */

import { ProductBreakdownCard } from "@/components/product-breakdown"
import { formatCurrency, type DashboardTool } from "@/lib/dashboard-types"
import type { ProductSlice } from "@/lib/product-breakdown"
import { cursorProductGroups } from "@/lib/cursor-products"

/** Claude.ai: Claude Code, Chat (incl. cowork), Other (with its raw labels). */
export function ClaudeAiProductSplit({ products, total, title = "Claude.ai by product" }: { products: ProductSlice[]; total: number; title?: string }) {
  return (
    <ProductBreakdownCard
      products={products}
      total={total}
      title={title}
      testId="claude-ai-products"
      description={
        <>
          Claude.ai spend split by product; adds up to the Claude.ai total of {formatCurrency(total)}. Chat includes cowork. Other lists the
          product labels it contains; spend with no product label is under Other.
        </>
      }
    />
  )
}

/**
 * Cursor: Grok Bot (grok-bot-* models), Bugbot (github_bugbot), Agent/Chat
 * (every other model). Issue #90: when seats are present, variable usage and
 * the seat subscription are separate groups, each with its own bar and shares
 * of its own subtotal (lib/cursor-products.ts cursorProductGroups).
 */
export function CursorProductSplit({
  products,
  total,
  title = "Cursor by product",
  usageWindow,
}: {
  products: ProductSlice[]
  total: number
  title?: string
  /** Issue #90: the calendar window of the usage slices, e.g. "Nov 1 – Nov 6, 2026 (month to date)". */
  usageWindow?: string | null
}) {
  const groups = cursorProductGroups(products, usageWindow)
  return (
    <ProductBreakdownCard
      products={products}
      total={total}
      title={title}
      testId="cursor-products"
      groups={groups}
      description={
        <>
          Calendar-month Cursor on-demand (usage-based) spend from usage events
          {usageWindow ? ` dated ${usageWindow} only` : ""}, split by model, plus seat subscription fees (Seats, 20th-to-20th
          seat cycle) when assigned; adds up to the Cursor total of {formatCurrency(total)}. Usage included in the
          Business plan is not billed and counts $0. Grok Bot is grok-bot-* models, Bugbot is github_bugbot, Agent/Chat is every other model.
          {groups && " Variable usage and the fixed seat subscription are shown apart; usage percentages are of the usage subtotal."}{" "}
          This is not the billing-cycle on-demand figure, which is shown on its own card and never added to this total.
        </>
      }
    />
  )
}

/**
 * Dashboard tab: one card per tool that carries `products` (Claude.ai, then
 * Cursor), each titled with the tool's name and summing to its spend.
 */
export function ToolProductCards({ tools, usageWindow }: { tools: DashboardTool[]; usageWindow?: string | null }) {
  const claudeAi = tools.find((t) => t.products?.some((p) => p.product === "claude_code"))
  const cursor = tools.find((t) => t.products?.some((p) => p.product === "grok_bot"))
  return (
    <>
      {claudeAi && <ClaudeAiProductSplit products={claudeAi.products!} total={claudeAi.monthlySpend} title={`${claudeAi.name} by product`} />}
      {cursor && <CursorProductSplit products={cursor.products!} total={cursor.monthlySpend} title={`${cursor.name} by product`} usageWindow={usageWindow} />}
    </>
  )
}
