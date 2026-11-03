/**
 * POST /api/admin/org/keys/assign-creator — { provider_id, external_key_id }
 * Vercel AI Gateway "Assign to creator" (issues #32, #34, lib/org/assign-creator):
 * a manual override for a registered gateway key (any spend attribution) with
 * a creator email whose owner isn't the creator's person (no owner, or someone
 * else). Sets the owner to the creator's person (matched by email, else
 * created with no team) with assignment_source 'manual'.
 * 404 when the key isn't registered, 409 when it isn't eligible (no creator
 * email, or already owned by its creator).
 */

import { z } from "zod"
import { adminRoute, HttpError, json, parseBody } from "@/lib/org/admin/http"
import { refreshRollups } from "@/lib/org/admin/repo"
import { AssignCreatorError, assignKeyToCreator } from "@/lib/org/assign-creator"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const bodySchema = z.object({ provider_id: z.string().min(1), external_key_id: z.string().min(1) }).strict()

export const POST = adminRoute(async (request, _params, admin) => {
  const body = await parseBody(request, bodySchema)
  let result
  try {
    result = await assignKeyToCreator(admin, body)
  } catch (e) {
    if (e instanceof AssignCreatorError) throw new HttpError(e.status, e.message)
    throw e
  }
  await refreshRollups()
  return json(result)
})
