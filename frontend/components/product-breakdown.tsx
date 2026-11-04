"use client"

/**
 * "<provider> by product" card and Tools-table sub-rows (issues #48, #65).
 * Presentational; the splits come from lib/claude-ai-products.ts and
 * lib/cursor-products.ts and always sum to the provider total they are shown
 * under. A slice with `labels` (Claude.ai Other) lists them under its amount
 * and in a tooltip.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TableCell, TableRow } from "@/components/ui/table"
import { formatCurrency } from "@/lib/dashboard-types"
import type { ProductSlice } from "@/lib/product-breakdown"

// Liatrio brand palette (as lib/dashboard-compute.ts); Other is the neutral grey.
export const PRODUCT_COLOR: Record<string, string> = {
  // Claude.ai
  claude_code: "#00C1DB", // Lagoon
  chat: "#C068F9", // Violet
  other: "#666666", // Grey 500
  // Cursor
  agent_chat: "#006989", // Deep Sea
  grok_bot: "#F77F00", // Flame Orange
  bugbot: "#89DF00", // Bright Green
}
const colorOf = (product: string) => PRODUCT_COLOR[product] ?? "#666666"

const share = (cost: number, total: number) => (total > 0 ? `${((cost / total) * 100).toFixed(1)}%` : "–")

/** Visible labels before "+N more" (the tooltip always has all of them). */
const MAX_LABELS = 6

function labelsTitle(p: ProductSlice): string | undefined {
  return p.labels && p.labels.length > 0 ? `${p.label} includes: ${p.labels.join(", ")}` : undefined
}

/** Indented sub-rows under a provider row of a table (Tools tab). */
export function ProductSubRows({ products, colSpanAfter = 0 }: { products: ProductSlice[]; colSpanAfter?: number }) {
  return (
    <>
      {products.map((p) => (
        <TableRow key={p.product} data-testid="product-row" data-product={p.product} className="border-0 hover:bg-transparent">
          <TableCell className="py-1 pl-8">
            <div className="flex items-center gap-2 text-sm text-muted-foreground" title={labelsTitle(p)}>
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: colorOf(p.product) }} />
              {p.label}
            </div>
          </TableCell>
          <TableCell className="hidden py-1 lg:table-cell" />
          <TableCell className="py-1 font-mono text-sm text-muted-foreground">{formatCurrency(p.cost)}</TableCell>
          {colSpanAfter > 0 && <TableCell className="py-1" colSpan={colSpanAfter} />}
        </TableRow>
      ))}
    </>
  )
}

/** Card with a stacked bar and one line per product (Dashboard tab and person view). */
export function ProductBreakdownCard({
  products,
  total,
  title,
  description,
  testId,
}: {
  products: ProductSlice[]
  total: number
  title: string
  description: React.ReactNode
  testId: string
}) {
  const positive = products.filter((p) => p.cost > 0)
  const barTotal = positive.reduce((s, p) => s + p.cost, 0)
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur" data-testid={testId}>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {barTotal > 0 && (
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
            {positive.map((p) => (
              <div key={p.product} title={labelsTitle(p)} style={{ width: `${(p.cost / barTotal) * 100}%`, backgroundColor: colorOf(p.product) }} />
            ))}
          </div>
        )}
        <ul className="grid gap-2 sm:grid-cols-3">
          {products.map((p) => (
            <li key={p.product} className="rounded-md border border-border/50 px-3 py-2" title={labelsTitle(p)}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex items-center gap-2 text-sm">
                  <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: colorOf(p.product) }} />
                  {p.label}
                </span>
                <span className="text-right">
                  <span className="font-mono text-sm tabular-nums">{formatCurrency(p.cost)}</span>
                  <span className="ml-2 text-xs text-muted-foreground tabular-nums">{share(p.cost, total)}</span>
                </span>
              </div>
              {p.labels && p.labels.length > 0 && (
                <p className="mt-1 break-words text-xs text-muted-foreground" data-testid="product-labels">
                  {p.labels.slice(0, MAX_LABELS).join(", ")}
                  {p.labels.length > MAX_LABELS && ` +${p.labels.length - MAX_LABELS} more`}
                </p>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
