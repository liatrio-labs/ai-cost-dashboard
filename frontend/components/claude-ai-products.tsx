"use client"

/**
 * Provider "by product" cards (issue #48 Claude.ai, issue #65 Cursor), built on
 * the shared ProductBreakdownCard (components/product-breakdown.tsx).
 */

import { ProductBreakdownCard } from "@/components/product-breakdown"
import { formatCurrency, type DashboardTool } from "@/lib/dashboard-types"
import type { ProductSlice } from "@/lib/product-breakdown"

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

/** Cursor: Grok Bot (grok-bot-* models), Bugbot (github_bugbot), Agent/Chat (every other model). */
export function CursorProductSplit({ products, total, title = "Cursor by product" }: { products: ProductSlice[]; total: number; title?: string }) {
  return (
    <ProductBreakdownCard
      products={products}
      total={total}
      title={title}
      testId="cursor-products"
      description={
        <>
          Calendar-month Cursor on-demand (usage-based) spend from usage events, split by model, plus seat subscription fees (Seats, 20th-to-20th
          seat cycle) when assigned; adds up to the Cursor total of {formatCurrency(total)}. Usage included in the
          Business plan is not billed and counts $0. Grok Bot is grok-bot-* models, Bugbot is github_bugbot, Agent/Chat is every other model.
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
export function ToolProductCards({ tools }: { tools: DashboardTool[] }) {
  const claudeAi = tools.find((t) => t.products?.some((p) => p.product === "claude_code"))
  const cursor = tools.find((t) => t.products?.some((p) => p.product === "grok_bot"))
  return (
    <>
      {claudeAi && <ClaudeAiProductSplit products={claudeAi.products!} total={claudeAi.monthlySpend} title={`${claudeAi.name} by product`} />}
      {cursor && <CursorProductSplit products={cursor.products!} total={cursor.monthlySpend} title={`${cursor.name} by product`} />}
    </>
  )
}
