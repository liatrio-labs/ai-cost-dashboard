/**
 * Needs-review inbox (issue #44).
 *
 * GET  /api/admin/org/review  items computed live (lib/org/review-inbox.ts),
 *      minus those acknowledged / assigned whose amount hasn't grown > 25%.
 *      Without migration 018: every item, decisions_available false and a
 *      "migration 018 not applied" notice (200, not 500).
 * POST /api/admin/org/review  { kind, subject, period, amount, status?, note? }
 *      records an Acknowledge (or, after the existing assign flow, an Assign)
 *      with an optional note. Without migration 018: 409
 *      { error: "Migration 018 not applied: ...", code: "migration_018_not_applied" }.
 */

import { adminRoute, json, parseBody } from "@/lib/org/admin/http"
import { loadReviewInbox, reviewDecisionSchema, saveDecision } from "@/lib/org/admin/review"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = adminRoute(async (_request, _params, admin) => json(await loadReviewInbox(admin)))

export const POST = adminRoute(async (request, _params, admin, user) => {
  const body = await parseBody(request, reviewDecisionSchema)
  return json(await saveDecision(admin, body, user.email), 201)
})
