/**
 * Default display names from firstname.lastname@liatrio.com (issue #66).
 *
 * A stored name is a "placeholder" when it is null, blank, the email, or the
 * email's local part (case-insensitive). Only placeholders are ever replaced
 * by the derived default; any other value is a manual name and is kept.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

const LIATRIO_NAME = /^([a-z]+(?:-[a-z]+)*)\.([a-z]+(?:-[a-z]+)*)@liatrio\.com$/i

const titleCase = (part: string) =>
  part
    .toLowerCase()
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("-")

/** "First Last" for first.last@liatrio.com (hyphen segments title-cased), else null. */
export function defaultDisplayName(email: string | null | undefined): string | null {
  const m = LIATRIO_NAME.exec((email ?? "").trim())
  return m ? `${titleCase(m[1])} ${titleCase(m[2])}` : null
}

/** True when `name` is null, blank, the email, or its local part (case-insensitive). */
export function isPlaceholderName(name: string | null | undefined, email: string): boolean {
  const n = (name ?? "").trim().toLowerCase()
  if (!n) return true
  const e = email.trim().toLowerCase()
  return n === e || n === e.split("@")[0]
}

/**
 * The display_name for a new person: the given (provider / admin) name when
 * it is a real name, else the derived default, else the given value as before.
 */
export function newPersonDisplayName(given: string | null | undefined, email: string): string | null {
  if (!isPlaceholderName(given, email)) return given ?? null
  return defaultDisplayName(email) ?? given ?? null
}

export interface PersonNameRow {
  id: string
  email: string
  display_name: string | null
}

/** The rows whose placeholder name would be replaced by a derived default. */
export function defaultNameUpdates(people: PersonNameRow[]): { id: string; from: string | null; to: string }[] {
  const out: { id: string; from: string | null; to: string }[] = []
  for (const p of people) {
    if (!isPlaceholderName(p.display_name, p.email)) continue
    const to = defaultDisplayName(p.email)
    if (to && to !== p.display_name) out.push({ id: p.id, from: p.display_name, to })
  }
  return out
}

/**
 * Fill derived default names where the stored name is a placeholder. Each
 * update is conditional on the name still being what was read, so a manual
 * name typed in the meantime is never overwritten. Returns the count updated.
 * Pass `people` to limit it to those rows; omit to scan everyone.
 */
export async function backfillDefaultDisplayNames(admin: SupabaseClient, people?: PersonNameRow[]): Promise<number> {
  let rows = people
  if (!rows) {
    const res = await admin.from("people").select("id, email, display_name")
    if (res.error) throw new Error(`Failed to read people: ${res.error.message}`)
    rows = (res.data ?? []) as PersonNameRow[]
  }
  let updated = 0
  for (const u of defaultNameUpdates(rows)) {
    const q = admin.from("people").update({ display_name: u.to }).eq("id", u.id)
    const res = await (u.from === null ? q.is("display_name", null) : q.eq("display_name", u.from)).select("id")
    if (res.error) throw new Error(`Failed to update people: ${res.error.message}`)
    updated += (res.data ?? []).length
  }
  return updated
}
