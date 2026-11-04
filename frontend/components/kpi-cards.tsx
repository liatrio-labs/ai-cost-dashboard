"use client"

import { Card, CardContent } from "@/components/ui/card"
import { TrendingUp, TrendingDown, Minus, DollarSign, Boxes, Zap, Trophy } from "lucide-react"
import {
  formatCurrency,
  projectedChangeLabel,
  projectionTooltip,
  type DashboardKpis,
  type DashboardProjection,
} from "@/lib/dashboard-types"

interface KPICardsProps {
  kpis: DashboardKpis
  /** Issue #39: when the period contains today, the change is projected. */
  projection?: DashboardProjection
}

/** The spend card's change line: projected MoM for the current period, none for a future one. */
export function spendChange(kpis: DashboardKpis, projection?: DashboardProjection) {
  if (projection?.status === "future") return { trend: "stable" as const, label: "no data yet", title: undefined }
  const p = projection?.status === "current" ? projection.kpis : null
  if (p) {
    const pct = p.changePercent
    return {
      trend: pct === null || pct === 0 ? ("stable" as const) : pct > 0 ? ("up" as const) : ("down" as const),
      label: pct === null ? "new (projected)" : projectedChangeLabel(pct),
      title: `${projectionTooltip(projection!.basis, p.actualToDate)}; projected ${formatCurrency(p.projectedSpend)} vs ${formatCurrency(p.compareSpend)}`,
    }
  }
  return {
    trend: kpis.changePercent > 0 ? ("up" as const) : kpis.changePercent < 0 ? ("down" as const) : ("stable" as const),
    label: `${kpis.changePercent > 0 ? "+" : ""}${kpis.changePercent}% MoM`,
    title: undefined as string | undefined,
  }
}

function formatTokens(n: number): string {
  if (!n) return "—"
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return `${n}`
}

export function KPICards({ kpis, projection }: KPICardsProps) {
  const spend = spendChange(kpis, projection)

  const cards: { title: string; value: string; change: string; icon: typeof DollarSign; trend: "up" | "down" | "stable"; tooltip?: string }[] = [
    {
      title: "Total Monthly Spend",
      value: formatCurrency(kpis.totalSpend),
      change: spend.label,
      icon: DollarSign,
      trend: spend.trend,
      tooltip: spend.title,
    },
    {
      title: "Total Tokens",
      value: formatTokens(kpis.totalTokens),
      change: "this month",
      icon: Zap,
      trend: "stable" as const,
    },
    {
      title: "Active Providers",
      value: kpis.activeProviders.toString(),
      change: "with spend",
      icon: Boxes,
      trend: "stable" as const,
    },
    {
      title: "Top Provider",
      value: kpis.topProvider,
      change: "by spend",
      icon: Trophy,
      trend: "stable" as const,
    },
  ]

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((kpi) => (
        <Card key={kpi.title} className="border-border/50 bg-card/50 backdrop-blur">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div className="rounded-lg bg-primary/10 p-2">
                <kpi.icon className="h-5 w-5 text-primary" />
              </div>
              <div className="flex items-center gap-1 text-sm" title={kpi.tooltip}>
                {kpi.trend === "up" && <TrendingUp className="h-4 w-4 text-emerald-500" />}
                {kpi.trend === "down" && <TrendingDown className="h-4 w-4 text-red-500" />}
                {kpi.trend === "stable" && <Minus className="h-4 w-4 text-muted-foreground" />}
                <span
                  className={
                    kpi.trend === "up"
                      ? "text-emerald-500"
                      : kpi.trend === "down"
                        ? "text-red-500"
                        : "text-muted-foreground"
                  }
                >
                  {kpi.change}
                </span>
              </div>
            </div>
            <div className="mt-4">
              <p className="text-2xl font-bold text-foreground">{kpi.value}</p>
              <p className="text-sm text-muted-foreground">{kpi.title}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
