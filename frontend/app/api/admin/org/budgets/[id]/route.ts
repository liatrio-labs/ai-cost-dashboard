/**
 * DELETE /api/admin/org/budgets/:id  removes one budget (issue #49).
 * 404 when it doesn't exist; 409 { code: "migration_020_not_applied" } without migration 020.
 */

import { adminRoute, json } from "@/lib/org/admin/http"
import { deleteBudget } from "@/lib/org/admin/budgets"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Params = { id: string }

export const DELETE = adminRoute<Params>(async (_request, { id }, admin) => {
  await deleteBudget(admin, id)
  return json({ deleted: id })
})
