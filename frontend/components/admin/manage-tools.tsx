"use client"

import { useState } from "react"
import { Loader2, Save, Trash2, ExternalLink, CheckCircle2, AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

export interface ToolRow {
  id: string
  name: string
  display_name: string
  documentation_url: string | null
  metadata?: { description?: string; collection_method?: string } | null
}

interface ManageToolsProps {
  tools: ToolRow[]
  /** Called after a successful save/delete so the parent can reload. */
  onChanged: () => void
}

export function ManageTools({ tools, onChanged }: ManageToolsProps) {
  if (!tools.length) {
    return <p className="text-sm text-muted-foreground">No tools yet.</p>
  }
  return (
    <div className="divide-y divide-border/50">
      {tools.map((t) => (
        <ToolEditor key={t.id} tool={t} onChanged={onChanged} />
      ))}
    </div>
  )
}

function ToolEditor({ tool, onChanged }: { tool: ToolRow; onChanged: () => void }) {
  const [displayName, setDisplayName] = useState(tool.display_name || "")
  const [description, setDescription] = useState(tool.metadata?.description || "")
  const [adminUrl, setAdminUrl] = useState(tool.documentation_url || "")
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const dirty =
    displayName.trim() !== (tool.display_name || "") ||
    description !== (tool.metadata?.description || "") ||
    adminUrl !== (tool.documentation_url || "")

  async function save() {
    if (!displayName.trim()) {
      setMsg({ ok: false, text: "Name can't be empty." })
      return
    }
    setSaving(true)
    setMsg(null)
    try {
      const res = await fetch("/api/admin/providers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: tool.id, display_name: displayName, description, admin_url: adminUrl }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMsg({ ok: false, text: body.error || `HTTP ${res.status}` })
        return
      }
      setMsg({ ok: true, text: "Saved." })
      onChanged()
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || "Request failed" })
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    setDeleting(true)
    setMsg(null)
    try {
      const res = await fetch(`/api/admin/providers?id=${encodeURIComponent(tool.id)}`, {
        method: "DELETE",
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMsg({ ok: false, text: body.error || `HTTP ${res.status}` })
        setConfirmDelete(false)
        return
      }
      onChanged()
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message || "Request failed" })
    } finally {
      setDeleting(false)
    }
  }

  const isApi = (tool.metadata?.collection_method || "manual") !== "manual"

  return (
    <div className="space-y-3 py-4">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs text-muted-foreground">
          {tool.name}
          {isApi ? " · API-collected" : " · manual"}
        </p>
        {adminUrl ? (
          <a
            href={adminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
          >
            Platform admin <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Platform name</label>
        <Input
          placeholder="Display name on the dashboard"
          value={displayName}
          onChange={(e) => {
            setDisplayName(e.target.value)
            setMsg(null)
          }}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          <Textarea
            rows={2}
            placeholder="What this tool is used for…"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value)
              setMsg(null)
            }}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Platform admin URL (where to pull more data)
          </label>
          <Input
            type="url"
            placeholder="https://…"
            value={adminUrl}
            onChange={(e) => {
              setAdminUrl(e.target.value)
              setMsg(null)
            }}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving || !dirty} className="gap-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save
        </Button>

        {!confirmDelete ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmDelete(true)}
            className="gap-2 text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        ) : (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1">
            <span className="text-xs text-destructive">
              Delete {tool.display_name} and all its cost records?
            </span>
            <Button size="sm" variant="destructive" onClick={remove} disabled={deleting} className="gap-1">
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Yes, delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Cancel
            </Button>
          </div>
        )}

        {msg && (
          <span
            className={`flex items-center gap-1 text-xs ${
              msg.ok ? "text-primary" : "text-destructive"
            }`}
          >
            {msg.ok ? <CheckCircle2 className="h-3 w-3" /> : <AlertCircle className="h-3 w-3" />}
            {msg.text}
          </span>
        )}
      </div>
    </div>
  )
}
