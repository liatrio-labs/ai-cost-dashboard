/**
 * Shared shape for "<provider> by product" splits (issues #48, #65): a few
 * named slices that always sum, to the cent, to the provider total they are
 * shown under. Claude.ai (lib/claude-ai-products.ts) and Cursor
 * (lib/cursor-products.ts) both produce a ProductSplit; the card is
 * components/product-breakdown.tsx.
 */

export interface ProductSlice<P extends string = string> {
  product: P
  label: string
  cost: number
  /**
   * Raw labels that landed in this slice, largest spend first. Set on catch-all
   * slices (Claude.ai Other) so the card can say what they contain.
   */
  labels?: string[]
}

export interface ProductSplit<P extends string = string> {
  /** Provider total for the rows split (rounded to cents, as the tool row shows it). */
  total: number
  /** Fixed order per provider; costs sum to `total`. */
  products: ProductSlice<P>[]
}

export const productNum = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Round `parts` to integers that sum to `target` (largest remainder). */
export function allocateCents(target: number, parts: number[]): number[] {
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

/**
 * Build a split from exact (unrounded) per-product dollars and the provider
 * total, rounding with largest remainders so the slices add up to the cent.
 */
export function roundSplit<P extends string>(
  order: readonly P[],
  labelOf: Record<P, string>,
  exact: Record<P, number>,
  total: number
): ProductSplit<P> {
  const totalCents = Math.round(total * 100)
  const cents = allocateCents(totalCents, order.map((p) => exact[p] * 100))
  return {
    total: totalCents / 100,
    products: order.map((p, i) => ({ product: p, label: labelOf[p], cost: cents[i] / 100 })),
  }
}

/**
 * Issue #90: slices shown as their own group (e.g. variable usage vs
 * subscription) with a subtotal; shares are of the group subtotal, never of
 * the card total.
 */
export interface ProductGroup<P extends string = string> {
  key: string
  label: string
  /** Sum of the group's (already cent-rounded) slices. */
  subtotal: number
  products: ProductSlice<P>[]
}

/** Sum of cent-rounded slice costs, kept in cents so groups add up to the split total. */
export function sliceSubtotal(products: ProductSlice[]): number {
  return products.reduce((c, p) => c + Math.round(p.cost * 100), 0) / 100
}
