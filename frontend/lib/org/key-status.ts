/**
 * Pure key helpers shared by the key syncs, the admin routes and the
 * /admin/org UI (issue #32). No I/O, safe for client components.
 */

import { normalizeEmail } from "./attribution"

/** Why the key sync left a key without an owner (org_api_keys.unresolved_reason, migration 017). */
export const UNRESOLVED_REASONS = ["no_creator", "service_account", "deleted_user", "unmatched_creator"] as const
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number]

export const UNRESOLVED_REASON_TEXT: Record<UnresolvedReason, string> = {
  no_creator: "no creator recorded",
  service_account: "created by a service account",
  deleted_user: "creator is no longer in the organization",
  unmatched_creator: "creator has no email to match",
}

/**
 * OpenAI (issue #46) stores unmatched_creator when the creator's email
 * matches no person (the OpenAI sync never creates people), so the label
 * differs for that provider.
 */
const PROVIDER_REASON_TEXT: Record<string, Partial<Record<UnresolvedReason, string>>> = {
  openai: { unmatched_creator: "creator's email matches no person" },
}

export function unresolvedReasonText(reason: string | null | undefined, providerSlug?: string | null): string | null {
  if (!reason) return null
  const byProvider = providerSlug ? (PROVIDER_REASON_TEXT[providerSlug] as Record<string, string> | undefined) : undefined
  return byProvider?.[reason] ?? (UNRESOLVED_REASON_TEXT as Record<string, string>)[reason] ?? reason
}

export const GATEWAY_PROVIDER = "vercel-ai-gateway"

export interface AssignableKey {
  owner_person_id: string | null
  spend_attribution?: string | null
  external_created_by_email?: string | null
}

/**
 * Vercel "Assign to creator" (issues #32, #34): an override for any gateway
 * key (any spend attribution) that has a creator email and whose owner isn't
 * that creator's person, i.e. an unowned key or one handed to someone else.
 * `ownerEmail` is the current owner's email (people.email); a key already
 * owned by its creator never shows it.
 */
export function canAssignToCreator(
  k: AssignableKey,
  providerSlug: string | null | undefined,
  ownerEmail?: string | null
): boolean {
  if (providerSlug !== GATEWAY_PROVIDER) return false
  const creator = normalizeEmail(k.external_created_by_email)
  if (!creator) return false
  return !k.owner_person_id || normalizeEmail(ownerEmail) !== creator
}
