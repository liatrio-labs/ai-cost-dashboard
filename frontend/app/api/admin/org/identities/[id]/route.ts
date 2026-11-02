/**
 * DELETE /api/admin/org/identities/:id — remove an identity mapping
 */

import { adminRoute, json, must } from "@/lib/org/admin/http"
import { findOr404, loadOrg, refreshRollups } from "@/lib/org/admin/repo"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Params = { id: string }

export const DELETE = adminRoute<Params>(async (_request, { id }, admin) => {
  const org = await loadOrg(admin)
  findOr404(org.identities as { id: string }[], id, "Identity")
  must(await admin.from("person_identities").delete().eq("id", id).select("id"))
  await refreshRollups()
  return json({ deleted: id })
})
