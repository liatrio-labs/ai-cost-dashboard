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

export function unresolvedReasonText(reason: string | null | undefined): string | null {
  if (!reason) return null
  return (UNRESOLVED_REASON_TEXT as Record<string, string>)[reason] ?? reason
}

export const GATEWAY_PROVIDER = "vercel-ai-gateway"

export interface AssignableKey {
  owner_person_id: string | null
  spend_attribution?: string | null
  external_created_by_email?: string | null
}

/**
 * Vercel "Assign to creator": a gateway key whose spend attribution is team
 * or unset, with a creator email and no owner. User-attributed keys are the
 * sync's job and never show it.
 */
export function canAssignToCreator(k: AssignableKey, providerSlug: string | null | undefined): boolean {
  return (
    providerSlug === GATEWAY_PROVIDER &&
    (k.spend_attribution == null || k.spend_attribution === "team") &&
    !!normalizeEmail(k.external_created_by_email) &&
    !k.owner_person_id
  )
}
