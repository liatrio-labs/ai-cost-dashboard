/**
 * GET /api/admin/org/people/duplicates (issue #51)
 *   -> { migration021: boolean, message: string | null, groups: DuplicateGroup[] }
 *
 * Likely duplicate people: same normalized name, or same email local-part
 * (lib/org/person-merge.ts). Each group lists a suggested primary first.
 * Works without migration 021; `migration021: false` (with `message`) tells
 * the UI that merging is disabled until it is applied. Admin only.
 */

import { adminRoute, json } from "@/lib/org/admin/http"
import { has021 } from "@/lib/org/admin/merge"
import { loadOrg } from "@/lib/org/admin/repo"
import { findLikelyDuplicates, MIGRATION_021_MESSAGE } from "@/lib/org/person-merge"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = adminRoute(async (_request, _params, admin) => {
  const [org, migration021] = await Promise.all([loadOrg(admin), has021(admin)])
  return json({
    migration021,
    message: migration021 ? null : MIGRATION_021_MESSAGE,
    groups: findLikelyDuplicates(org),
  })
})
