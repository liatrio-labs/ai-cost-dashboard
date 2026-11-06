/**
 * Issue #88: people records whose names look wrong in the Person filter
 * ("Deleted User" four times, a lowercase slug, a raw email, a first name
 * only). Pure and read-only: it only flags records so an admin can fix the
 * name or merge confirmed duplicates with the existing merge tool
 * (migration 021). It never merges, renames or deletes anything.
 */

export type HygieneReason = "placeholder_name" | "email_as_name" | "slug_name" | "first_name_only" | "duplicate_name"

export const HYGIENE_REASON_LABEL: Record<HygieneReason, string> = {
  placeholder_name: "placeholder name",
  email_as_name: "email shown as name",
  slug_name: "lowercase slug, not a name",
  first_name_only: "first name only",
  duplicate_name: "same name as another person",
}

export interface HygienePerson {
  id: string
  email: string
  display_name?: string | null
  active?: boolean | null
}

export interface HygieneFlag {
  person: HygienePerson
  label: string
  reasons: HygieneReason[]
}

const PLACEHOLDERS = /^(deleted user|unknown( user)?|user|n\/a|none|-+)$/i
const SLUG = /^[a-z0-9]+([-_.][a-z0-9]+)+$/

/** The name the dashboard shows for a person (display name, else email). */
export const personLabel = (p: HygienePerson) => (p.display_name?.trim() ? p.display_name.trim() : p.email)

/** People whose shown name needs an admin's look, with the reasons. Inactive people are skipped. */
export function peopleNeedingReview(people: HygienePerson[]): HygieneFlag[] {
  const active = people.filter((p) => p.active !== false)
  const count = new Map<string, number>()
  for (const p of active) {
    const k = personLabel(p).toLowerCase()
    count.set(k, (count.get(k) ?? 0) + 1)
  }
  const out: HygieneFlag[] = []
  for (const p of active) {
    const label = personLabel(p)
    const reasons: HygieneReason[] = []
    if (PLACEHOLDERS.test(label)) reasons.push("placeholder_name")
    if (label.includes("@")) reasons.push("email_as_name")
    else if (SLUG.test(label)) reasons.push("slug_name")
    else if (!PLACEHOLDERS.test(label) && !/\s/.test(label)) reasons.push("first_name_only")
    if ((count.get(label.toLowerCase()) ?? 0) > 1) reasons.push("duplicate_name")
    if (reasons.length) out.push({ person: p, label, reasons })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label) || a.person.email.localeCompare(b.person.email))
}
