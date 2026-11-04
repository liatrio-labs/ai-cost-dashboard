"use client"

/**
 * Claude.ai spend by product (issue #48): Claude Code, Chat, Other.
 * Presentational; the split comes from lib/claude-ai-products.ts and always
 * sums to the Claude.ai total it is shown under.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TableCell, TableRow } from "@/components/ui/table"
import { formatCurrency } from "@/lib/dashboard-types"
import type { ClaudeAiProduct, ProductSlice } from "@/lib/claude-ai-products"

// Liatrio brand palette (as lib/dashboard-compute.ts); Other is the neutral grey.
export const PRODUCT_COLOR: Record<ClaudeAiProduct, string> = {
  claude_code: "#00C1DB", // Lagoon
  chat: "#C068F9", // Violet
  other: "#666666", // Grey 500
}

const share = (cost: number, total: number) => (total > 0 ? `${((cost / total) * 100).toFixed(1)}%` : "–")

/** Indented sub-rows under the Claude.ai row of a table (Tools tab). */
export function ClaudeAiProductSubRows({ products, colSpanAfter = 0 }: { products: ProductSlice[]; colSpanAfter?: number }) {
  return (
    <>
      {products.map((p) => (
        <TableRow key={p.product} data-testid="claude-ai-product-row" className="border-0 hover:bg-transparent">
          <TableCell className="py-1 pl-8">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: PRODUCT_COLOR[p.product] }} />
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
export function ClaudeAiProductSplit({ products, total, title = "Claude.ai by product" }: { products: ProductSlice[]; total: number; title?: string }) {
  const positive = products.filter((p) => p.cost > 0)
  const barTotal = positive.reduce((s, p) => s + p.cost, 0)
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur" data-testid="claude-ai-products">
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>
          Claude.ai spend split by product; adds up to the Claude.ai total of {formatCurrency(total)}. Spend with no product label is under Other.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {barTotal > 0 && (
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
            {positive.map((p) => (
              <div key={p.product} style={{ width: `${(p.cost / barTotal) * 100}%`, backgroundColor: PRODUCT_COLOR[p.product] }} />
            ))}
          </div>
        )}
        <ul className="grid gap-2 sm:grid-cols-3">
          {products.map((p) => (
            <li key={p.product} className="flex items-baseline justify-between gap-2 rounded-md border border-border/50 px-3 py-2">
              <span className="flex items-center gap-2 text-sm">
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: PRODUCT_COLOR[p.product] }} />
                {p.label}
              </span>
              <span className="text-right">
                <span className="font-mono text-sm tabular-nums">{formatCurrency(p.cost)}</span>
                <span className="ml-2 text-xs text-muted-foreground tabular-nums">{share(p.cost, total)}</span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
