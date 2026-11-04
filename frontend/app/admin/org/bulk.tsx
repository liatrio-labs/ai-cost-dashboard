"use client"

/**
 * Bulk team assignment UI for /admin/org (issue #43): row selection, the
 * "Assign team" bar for People and Projects, and the CSV import card on the
 * Import tab. Writes go through the admin-only bulk endpoints
 * (POST /api/admin/org/people/bulk, /projects/bulk, /import/csv).
 */

import { useCallback, useMemo, useState } from "react"
import { AlertCircle, Loader2, Upload } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { CsvKind, CsvPreview, CsvRowResult, RowStatus } from "@/lib/org/admin/csv"
import { TeamSelect, selectClass, type Org } from "./shared"

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Selected row keys. Keys that are no longer among `visible` (filtered out,
 * deleted) are dropped from what callers see, so a hidden row is never
 * assigned by accident.
 */
export function useSelection(visible: string[]) {
  const [raw, setRaw] = useState<Set<string>>(new Set())
  const selected = useMemo(() => new Set(visible.filter((k) => raw.has(k))), [raw, visible])
  const allSelected = visible.length > 0 && selected.size === visible.length
  const toggle = useCallback((key: string, on: boolean) => {
    setRaw((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  const setAll = useCallback((on: boolean) => setRaw(on ? new Set(visible) : new Set()), [visible])
  const clear = useCallback(() => setRaw(new Set()), [])
  return { selected, allSelected, someSelected: selected.size > 0 && !allSelected, toggle, setAll, clear }
}

/** Header checkbox: selects every row in the current (filtered) list. */
export function SelectAllCheckbox({
  label,
  all,
  some,
  disabled,
  onChange,
}: {
  label: string
  all: boolean
  some: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <label className="flex items-center gap-1 text-sm text-muted-foreground">
      <input
        type="checkbox"
        aria-label={label}
        checked={all}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = some
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      Select all
    </label>
  )
}

type BulkTeamBarProps = {
  org: Org
  count: number
  noun: string
  plural?: string
  noneLabel?: string
  onAssign: (teamId: string | null) => Promise<boolean>
  onClear: () => void
}

/**
 * "N selected · team · Assign team" bar shown while rows are selected. The
 * bar's state (team choice, busy, last error) lives in BulkTeamBarInner,
 * which unmounts when the selection empties, so a new selection starts clean.
 */
export function BulkTeamBar(props: BulkTeamBarProps) {
  return props.count ? <BulkTeamBarInner {...props} /> : null
}

function BulkTeamBarInner({
  org,
  count,
  noun,
  plural = `${noun}s`,
  noneLabel = "Unassigned",
  onAssign,
  onClear,
}: BulkTeamBarProps) {
  const [team, setTeam] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const teamName = team ? (org.teams.find((t) => t.id === team)?.name ?? "team") : noneLabel
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm"
      role="region"
      aria-label={`Bulk assign ${plural}`}
    >
      <span className="font-medium">
        {count} {count === 1 ? noun : plural} selected
      </span>
      <TeamSelect org={org} value={team} noneLabel={noneLabel} ariaLabel={`Team for selected ${plural}`} onChange={setTeam} />
      <Button
        size="sm"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          setError(null)
          let ok = false
          try {
            ok = await onAssign(team)
          } catch (e) {
            // A network or parse failure: report it and keep the selection so it can be retried.
            setError(e instanceof Error && e.message ? e.message : "Request failed")
          } finally {
            setBusy(false)
          }
          if (ok) onClear()
        }}
      >
        {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
        Assign team: {teamName}
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear
      </Button>
      {error && (
        <span className="flex items-center gap-1 text-destructive" role="alert">
          <AlertCircle className="h-4 w-4" />
          {error}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<RowStatus, string> = {
  change: "change",
  unchanged: "unchanged",
  unmatched: "unmatched",
  unknown_team: "unknown team",
  invalid: "invalid",
}

const FORMAT: Record<CsvKind, { header: string; example: string }> = {
  people: { header: "email,team[,department]", example: "email,team,department\nalice@liatrio.com,Platform,Engineering\nbob@liatrio.com,Field" },
  projects: { header: "project,team", example: "project,team\nproj_abc123,Data\nSales tools,Field" },
}

type CsvResponse = CsvPreview & { dry_run: boolean; applied?: number; created_teams?: { name: string }[]; error?: string }

export function CsvImportCard({ org, onApplied }: { org: Org; onApplied: () => Promise<void> }) {
  const [kind, setKind] = useState<CsvKind>("people")
  const [csv, setCsv] = useState("")
  const [createTeams, setCreateTeams] = useState(false)
  const [preview, setPreview] = useState<CsvResponse | null>(null)
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  // Any input change invalidates the preview: apply only what was previewed.
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setPreview(null)
    setMsg(null)
  }

  async function send(confirm: boolean): Promise<CsvResponse | null> {
    let res: Response
    try {
      res = await fetch("/api/admin/org/import/csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, csv, confirm, create_teams: createTeams }),
      })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error && e.message ? `Request failed: ${e.message}` : "Request failed" })
      return null
    }
    const data = (await res.json().catch(() => ({}))) as CsvResponse
    if (!res.ok) {
      setMsg({ ok: false, text: data.error || `Request failed (${res.status})` })
      return null
    }
    return data
  }

  async function runPreview() {
    setBusy("preview")
    setMsg(null)
    try {
      const data = await send(false)
      if (data) setPreview(data)
    } finally {
      setBusy(null)
    }
  }

  async function apply() {
    setBusy("apply")
    setMsg(null)
    let data: CsvResponse | null
    try {
      data = await send(true)
    } finally {
      setBusy(null)
    }
    if (!data) return
    const created = data.created_teams?.length ? `; created ${data.created_teams.length} team(s): ${data.created_teams.map((t) => t.name).join(", ")}` : ""
    setMsg({ ok: true, text: `Applied ${data.applied ?? 0} change(s)${created}. Unmatched and invalid rows were not changed.` })
    setPreview(null)
    await onApplied()
  }

  const shown = preview?.rows.filter((r) => r.status !== "unchanged") ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle>Assign teams from CSV</CardTitle>
        <CardDescription>
          People: <code>{FORMAT.people.header}</code>. Projects: <code>{FORMAT.projects.header}</code> (project id or name). A header row is
          optional. Teams match by name; the department column picks between teams with the same name and is where a new team is created. Preview
          first: nothing changes until you apply, and unmatched or invalid rows are never written.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <select aria-label="CSV type" className={selectClass} value={kind} onChange={(e) => edit(setKind)(e.target.value as CsvKind)}>
            <option value="people">People (email, team, department)</option>
            <option value="projects">Projects (project, team)</option>
          </select>
          <label className="flex cursor-pointer items-center gap-1 text-sm text-muted-foreground">
            <Upload className="h-4 w-4" />
            <span>Choose file</span>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className="sr-only"
              aria-label="CSV file"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (file) edit(setCsv)(await file.text())
                e.target.value = ""
              }}
            />
          </label>
          <label className="flex items-center gap-1 text-sm text-muted-foreground">
            <input type="checkbox" checked={createTeams} onChange={(e) => edit(setCreateTeams)(e.target.checked)} />
            Create unknown teams on apply
          </label>
        </div>
        <textarea
          aria-label="CSV"
          className="min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          placeholder={FORMAT[kind].example}
          value={csv}
          onChange={(e) => edit(setCsv)(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <Button onClick={runPreview} disabled={!csv.trim() || busy !== null} className="gap-2">
            {busy === "preview" && <Loader2 className="h-4 w-4 animate-spin" />}
            Preview (dry run)
          </Button>
          {preview && (
            <Button onClick={apply} disabled={!preview.counts.changes || busy !== null} className="gap-2" variant="default">
              {busy === "apply" && <Loader2 className="h-4 w-4 animate-spin" />}
              Apply {preview.counts.changes} change{preview.counts.changes === 1 ? "" : "s"}
            </Button>
          )}
        </div>
        {msg && (
          <p className={`flex items-center gap-1 text-sm ${msg.ok ? "text-muted-foreground" : "text-destructive"}`}>
            {!msg.ok && <AlertCircle className="h-4 w-4" />}
            {msg.text}
          </p>
        )}
        {preview && <CsvPreviewView preview={preview} rows={shown} org={org} />}
      </CardContent>
    </Card>
  )
}

function CsvPreviewView({ preview, rows, org }: { preview: CsvPreview; rows: CsvRowResult[]; org: Org }) {
  const c = preview.counts
  const teamName = (id: string | null | undefined) => (id ? (org.teams.find((t) => t.id === id)?.name ?? id) : "none")
  return (
    <div className="space-y-3" data-testid="csv-preview">
      <p className="text-sm" data-testid="csv-counts">
        {c.rows} row(s): {c.matched} matched ({c.changes} to change, {c.unchanged} unchanged) · {c.unmatched} unmatched · {c.unknown_team} unknown
        team · {c.invalid} invalid
      </p>
      {preview.unknown_teams.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Unknown teams: {preview.unknown_teams.map((u) => `${u.name}${u.department_name ? ` (${u.department_name})` : ""}`).join(", ")}.{" "}
          {c.unknown_team > 0 ? "Tick “Create unknown teams on apply” and preview again to create them." : "They will be created on apply."}
        </p>
      )}
      {rows.length > 0 && (
        <div className="max-h-96 divide-y divide-border/50 overflow-auto rounded-md border border-border/50 text-sm">
          {rows.map((r) => (
            <div key={r.line} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5" data-testid="csv-row">
              <span className="min-w-0">
                <span className="mr-2 text-xs text-muted-foreground">line {r.line}</span>
                <span className="font-medium">{r.input || "(blank)"}</span>
                {r.project_name && r.project_name !== r.input && <span className="ml-1 text-muted-foreground">({r.project_name})</span>}
                {r.message && <span className="ml-2 text-xs text-muted-foreground">{r.message}</span>}
              </span>
              <span className="flex items-center gap-2 text-xs">
                {r.status === "change" && (
                  <span className="text-muted-foreground">
                    {teamName(r.current_team_id)} → {r.team?.name}
                    {!r.team?.id && " (new)"}
                  </span>
                )}
                <Badge variant={r.status === "change" ? "default" : r.status === "unmatched" || r.status === "invalid" ? "secondary" : "outline"}>
                  {STATUS_LABEL[r.status]}
                </Badge>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
