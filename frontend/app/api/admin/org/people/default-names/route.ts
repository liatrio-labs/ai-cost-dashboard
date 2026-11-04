/**
 * POST /api/admin/org/people/default-names — admin-only backfill (issue #66).
 *
 * Sets display_name to "First Last" for first.last@liatrio.com people whose
 * name is a placeholder (null, blank, the email or its local part). Manual
 * names are never touched; running it again updates nothing. Returns
 * { updated } with the number of people renamed.
 */

import { adminRoute, json } from "@/lib/org/admin/http"
import { backfillDefaultDisplayNames } from "@/lib/org/display-name"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const POST = adminRoute(async (_request, _params, admin) => {
  const updated = await backfillDefaultDisplayNames(admin)
  return json({ updated })
})
