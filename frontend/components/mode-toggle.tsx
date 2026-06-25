"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { Monitor, Moon, Sun } from "lucide-react"

import { Button } from "@/components/ui/button"

const ORDER = ["system", "light", "dark"] as const
type Mode = (typeof ORDER)[number]

const ICON: Record<Mode, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

const LABEL: Record<Mode, string> = {
  system: "System theme",
  light: "Light theme",
  dark: "Dark theme",
}

/**
 * Cycles theme: System → Light → Dark → System. Defaults to following the
 * OS setting (next-themes `defaultTheme="system"`).
 */
export function ModeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  // Avoid hydration mismatch — the resolved theme is only known on the client.
  useEffect(() => setMounted(true), [])

  const current = (mounted ? (theme as Mode) : "system") ?? "system"
  const Icon = ICON[current] ?? Monitor

  const next = () => {
    const i = ORDER.indexOf(current)
    setTheme(ORDER[(i + 1) % ORDER.length])
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={next}
      title={LABEL[current]}
      aria-label={`Theme: ${LABEL[current]}. Click to change.`}
    >
      <Icon className="h-4 w-4" />
    </Button>
  )
}
