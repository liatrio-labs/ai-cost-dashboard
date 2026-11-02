/**
 * POST /api/admin/org/people/import — { confirm?, emails?, team_id? }
 *
 * Creates people from the distinct metadata.attribution.person_email values
 * in cost_records that don't resolve to anyone yet.
 *   - Without confirm: true it is a dry run. It returns the candidates and
 *     writes nothing.
 *   - With confirm: true it creates them (only `emails` if given), optionally
 *     on `team_id`, and returns what it created.
 */

import { adminRoute, json, must, parseBody } from "@/lib/org/admin/http"
import { previewPeopleImport } from "@/lib/org/admin/observed"
import { loadOrg, refreshRollups, scanRecords } from "@/lib/org/admin/repo"
import { importSchema } from "@/lib/org/admin/schemas"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = adminRoute(async (request, _params, admin) => {
  const org = await loadOrg(admin)
  const body = await parseBody(request, importSchema(org))
  const records = await scanRecords(admin, { requireField: "person_email" })
  const preview = previewPeopleImport(records, org)

  if (body.confirm !== true) {
    return json({ dry_run: true, ...preview, would_create: preview.candidates.length })
  }

  const wanted = body.emails ? new Set(body.emails) : null
  const toCreate = preview.candidates.filter((c) => !wanted || wanted.has(c.email))
  const skipped = wanted ? [...wanted].filter((e) => !toCreate.some((c) => c.email === e)) : []

  let created: unknown[] = []
  if (toCreate.length) {
    created =
      must(
        await admin
          .from("people")
          .insert(
            toCreate.map((c) => ({
              email: c.email,
              display_name: c.display_name,
              team_id: body.team_id ?? null,
              active: true,
            }))
          )
          .select("id, email, display_name, team_id, active")
      ) ?? []
    await refreshRollups()
  }
  return json({ dry_run: false, created, skipped, already_known: preview.already_known }, 201)
})
