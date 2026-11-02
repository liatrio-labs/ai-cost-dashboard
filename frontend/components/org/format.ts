import { formatCurrency } from "@/lib/dashboard-types"

export { formatCurrency }

/** "+90%", "-12%", "0%", or "new" when there was no prior spend. */
export function formatChange(pct: number | null, spend: number): string {
  if (pct === null) return spend > 0 ? "new" : "—"
  return `${pct > 0 ? "+" : ""}${pct}%`
}

export function changeClass(pct: number | null): string {
  if (pct === null || Math.abs(pct) <= 5) return "text-muted-foreground"
  return pct > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
}
