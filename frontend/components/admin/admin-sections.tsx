"use client"

/**
 * Issue #88: the admin page is long, so it is grouped into sections with a
 * jump nav at the top. Each section collapses (native <details>, open by
 * default). The sync status strip stays the first thing in Data ingest, so
 * sync warnings remain visible on /admin.
 */

import Link from "next/link"
import { Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export const ADMIN_SECTIONS = [
  { id: "data-ingest", title: "Data ingest", description: "Sync status, provider pulls, monthly entries and recorded entries." },
  { id: "tools-costs", title: "Tools and costs", description: "Tools, recurring costs, invoice actuals, seat assignments and forecasts." },
  { id: "access", title: "Access", description: "Who can administer the dashboard, and people data cleanup." },
] as const

export function AdminSectionNav() {
  return (
    <nav aria-label="Admin sections" className="sticky top-16 z-40 -mx-1 flex flex-wrap gap-2 bg-background/90 px-1 py-2 backdrop-blur">
      {ADMIN_SECTIONS.map((s) => (
        <a key={s.id} href={`#${s.id}`} className="rounded-md border border-border/60 px-3 py-1 text-sm hover:bg-muted">
          {s.title}
        </a>
      ))}
    </nav>
  )
}

export function AdminSection({
  id,
  title,
  description,
  children,
}: {
  id: string
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-32">
      <details open className="group space-y-6">
        <summary className="cursor-pointer list-none select-none border-b border-border/60 pb-2">
          <h2 id={`${id}-title`} className="inline text-xl font-semibold">
            {title}
          </h2>
          <span className="ml-2 text-sm text-muted-foreground">{description}</span>
          <span className="ml-2 text-xs text-muted-foreground group-open:hidden">(collapsed, click to expand)</span>
        </summary>
        <div className="space-y-8 pt-4">{children}</div>
      </details>
    </section>
  )
}

/** Issue #88: where admins clean up duplicate-looking or unnamed people (no automatic merges). */
export function PeopleHygieneLink() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>People cleanup</CardTitle>
        <CardDescription>
          Names like &quot;Deleted User&quot;, raw emails, lowercase slugs or first-name-only entries show up in the Person filter. Review them
          under Org structure &gt; People, where &quot;Names to review&quot; lists them and Possible duplicates can merge records you
          confirm. Nothing is merged automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link href="/admin/org">
          <Button variant="outline" size="sm" className="gap-2">
            <Users className="h-4 w-4" />
            Open Org structure
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
