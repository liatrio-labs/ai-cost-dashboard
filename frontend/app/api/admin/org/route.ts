/**
 * GET /api/admin/org — the whole org structure (departments, teams, people,
 * identities, registered keys and projects) plus providers, for the admin UI.
 */

import { adminRoute, json } from "@/lib/org/admin/http"
import { loadOrg } from "@/lib/org/admin/repo"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = adminRoute(async (_request, _params, admin) => json(await loadOrg(admin)))
