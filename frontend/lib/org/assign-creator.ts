/**
 * Vercel AI Gateway "Assign to creator" (issues #32, #34).
 *
 * The key sync already makes the creator every gateway key's default owner
 * (auto). This is the manual override: for any gateway key (any spend
 * attribution) with a creator email whose owner isn't the creator's person
 * (no owner, or someone else), an admin can hand it to the creator in one
 * click. The owner becomes the creator's person (matched by email, else
 * created with no team) and the assignment is marked manual, so a later
 * "Sync keys now" leaves it alone.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizeEmail } from "./attribution"
import { canAssignToCreator, type AssignableKey } from "./key-status"
import { ensurePeople, must } from "./sync-helpers"

export class AssignCreatorError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
    this.name = "AssignCreatorError"
  }
}

/**
 * Set a registered gateway key's owner to its creator's person, manual.
 * Returns the updated key row and whether a person was created.
 */
export async function assignKeyToCreator(
  admin: SupabaseClient,
  input: { provider_id: string; external_key_id: string }
): Promise<{ key: Record<string, unknown>; person_id: string; person_created: boolean }> {
  const provider = must(
    await admin.from("providers").select("id, name").eq("id", input.provider_id).maybeSingle(),
    "Failed to read providers"
  ) as { id: string; name: string } | null
  if (!provider) throw new AssignCreatorError(404, "Provider not found")
  const key = must(
    await admin
      .from("org_api_keys")
      .select("id, provider_id, external_key_id, owner_person_id, spend_attribution, external_created_by_email, assignment_source")
      .eq("provider_id", input.provider_id)
      .eq("external_key_id", input.external_key_id)
      .maybeSingle(),
    "Failed to read org_api_keys"
  ) as (AssignableKey & { id: string }) | null
  if (!key) throw new AssignCreatorError(404, "Key is not registered; run Sync keys now first")
  let ownerEmail: string | null = null
  if (key.owner_person_id) {
    const owner = must(
      await admin.from("people").select("id, email").eq("id", key.owner_person_id).maybeSingle(),
      "Failed to read people"
    ) as { id: string; email: string | null } | null
    ownerEmail = owner?.email ?? null
  }
  if (!canAssignToCreator(key, provider.name, ownerEmail)) {
    throw new AssignCreatorError(
      409,
      "Assign to creator only applies to AI Gateway keys with a creator email that aren't already owned by their creator"
    )
  }
  const email = normalizeEmail(key.external_created_by_email)!
  const { personByEmail, created } = await ensurePeople(admin, new Map([[email, null]]))
  const personId = personByEmail.get(email)!
  const row = must(
    await admin
      .from("org_api_keys")
      .update({ owner_person_id: personId, assignment_source: "manual" })
      .eq("id", key.id)
      .select("id, provider_id, external_key_id, owner_person_id, assignment_source")
      .single(),
    "Failed to update org_api_keys"
  ) as Record<string, unknown>
  return { key: row, person_id: personId, person_created: created > 0 }
}
