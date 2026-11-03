/**
 * zod schemas for the admin org routes. Schemas that need to check references
 * (unknown team id) or uniqueness (duplicate team name in a department) are
 * built from the current org snapshot, so validation errors come back as 400s
 * with a clear message instead of database constraint errors.
 */

import { z } from "zod"
import { normalizeEmail } from "../attribution"
import type { Department, OrgApiKey, OrgProject, Person, PersonIdentity, Team } from "../types"

export interface ProviderRef {
  id: string
  name: string
  display_name?: string | null
}

/** Everything the admin routes validate against. */
export interface OrgSnapshot {
  departments: Department[]
  teams: Team[]
  people: Person[]
  identities: PersonIdentity[]
  apiKeys: OrgApiKey[]
  projects: OrgProject[]
  providers: ProviderRef[]
}

const name = z
  .string({ error: "Name is required" })
  .trim()
  .min(1, { error: "Name is required" })
  .max(200, { error: "Name must be 200 characters or fewer" })

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional()

const id = (label: string) =>
  z.string({ error: `${label} is required` }).trim().min(1, { error: `${label} is required` })

/** An id or null (null = unassign). */
const nullableId = (label: string) => id(label).nullable()

export const emailField = z
  .string({ error: "Email is required" })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "Invalid email address" }))

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

type Ctx = z.RefinementCtx

function unknownRef(ctx: Ctx, path: string, label: string, value: string) {
  ctx.addIssue({ code: "custom", path: [path], message: `Unknown ${label} id: ${value}` })
}

function checkTeam(org: Pick<OrgSnapshot, "teams">, ctx: Ctx, teamId: string | null | undefined, path = "team_id") {
  if (teamId && !org.teams.some((t) => t.id === teamId)) unknownRef(ctx, path, "team", teamId)
}

function checkPerson(org: Pick<OrgSnapshot, "people">, ctx: Ctx, personId: string | null | undefined, path: string) {
  if (personId && !org.people.some((p) => p.id === personId)) unknownRef(ctx, path, "person", personId)
}

function checkProvider(org: Pick<OrgSnapshot, "providers">, ctx: Ctx, providerId: string) {
  if (!org.providers.some((p) => p.id === providerId)) unknownRef(ctx, "provider_id", "provider", providerId)
}

function requireSomeField(v: Record<string, unknown>, ctx: Ctx) {
  if (Object.values(v).every((x) => x === undefined)) {
    ctx.addIssue({ code: "custom", path: [], message: "Nothing to update" })
  }
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

export function departmentCreateSchema(org: Pick<OrgSnapshot, "departments">) {
  return z
    .strictObject({ name, description: optionalText(2000) })
    .superRefine((v, ctx) => {
      if (org.departments.some((d) => sameName(d.name, v.name))) {
        ctx.addIssue({ code: "custom", path: ["name"], message: `A department named "${v.name}" already exists` })
      }
    })
}

export function departmentUpdateSchema(org: Pick<OrgSnapshot, "departments">, departmentId: string) {
  return z
    .strictObject({ name: name.optional(), description: optionalText(2000) })
    .superRefine((v, ctx) => {
      requireSomeField(v, ctx)
      if (v.name && org.departments.some((d) => d.id !== departmentId && sameName(d.name, v.name!))) {
        ctx.addIssue({ code: "custom", path: ["name"], message: `A department named "${v.name}" already exists` })
      }
    })
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

function duplicateTeam(org: Pick<OrgSnapshot, "teams">, teamName: string, departmentId: string | null, exceptId?: string) {
  return org.teams.some(
    (t) => t.id !== exceptId && (t.department_id ?? null) === departmentId && sameName(t.name, teamName)
  )
}

function teamDuplicateMessage(org: Pick<OrgSnapshot, "departments">, teamName: string, departmentId: string | null) {
  const dept = departmentId ? org.departments.find((d) => d.id === departmentId)?.name : null
  return dept
    ? `A team named "${teamName}" already exists in ${dept}`
    : `A team named "${teamName}" already exists without a department`
}

export function teamCreateSchema(org: Pick<OrgSnapshot, "teams" | "departments">) {
  return z
    .strictObject({ name, department_id: nullableId("department_id").optional() })
    .superRefine((v, ctx) => {
      const dept = v.department_id ?? null
      if (dept && !org.departments.some((d) => d.id === dept)) {
        unknownRef(ctx, "department_id", "department", dept)
        return
      }
      if (duplicateTeam(org, v.name, dept)) {
        ctx.addIssue({ code: "custom", path: ["name"], message: teamDuplicateMessage(org, v.name, dept) })
      }
    })
}

/** Rename and/or move a team between departments (department_id null = none). */
export function teamUpdateSchema(org: Pick<OrgSnapshot, "teams" | "departments">, teamId: string) {
  const current = org.teams.find((t) => t.id === teamId)
  return z
    .strictObject({ name: name.optional(), department_id: nullableId("department_id").optional() })
    .superRefine((v, ctx) => {
      requireSomeField(v, ctx)
      if (!current) return
      if (v.department_id && !org.departments.some((d) => d.id === v.department_id)) {
        unknownRef(ctx, "department_id", "department", v.department_id)
        return
      }
      const nextName = v.name ?? current.name
      const nextDept = v.department_id !== undefined ? v.department_id : (current.department_id ?? null)
      if (duplicateTeam(org, nextName, nextDept, teamId)) {
        ctx.addIssue({ code: "custom", path: ["name"], message: teamDuplicateMessage(org, nextName, nextDept) })
      }
    })
}

// ---------------------------------------------------------------------------
// People and identities
// ---------------------------------------------------------------------------

export function personCreateSchema(org: Pick<OrgSnapshot, "people" | "teams">) {
  return z
    .strictObject({
      email: emailField,
      display_name: optionalText(200),
      team_id: nullableId("team_id").optional(),
      active: z.boolean().optional(),
    })
    .superRefine((v, ctx) => {
      if (org.people.some((p) => normalizeEmail(p.email) === v.email)) {
        ctx.addIssue({ code: "custom", path: ["email"], message: `A person with email ${v.email} already exists` })
      }
      checkTeam(org, ctx, v.team_id)
    })
}

/** Edit, assign to a team (team_id null = unassign) or deactivate (active: false). */
export function personUpdateSchema(org: Pick<OrgSnapshot, "people" | "teams">, personId: string) {
  return z
    .strictObject({
      email: emailField.optional(),
      display_name: optionalText(200),
      team_id: nullableId("team_id").optional(),
      active: z.boolean().optional(),
    })
    .superRefine((v, ctx) => {
      requireSomeField(v, ctx)
      if (v.email && org.people.some((p) => p.id !== personId && normalizeEmail(p.email) === v.email)) {
        ctx.addIssue({ code: "custom", path: ["email"], message: `A person with email ${v.email} already exists` })
      }
      checkTeam(org, ctx, v.team_id)
    })
}

/**
 * Provider identity -> person. An external id that is an email is trimmed and
 * lower-cased (the resolver matches attribution.person_email that way); any
 * other id is only trimmed and must match exactly.
 */
export function identityCreateSchema(org: Pick<OrgSnapshot, "people" | "providers" | "identities">) {
  return z
    .strictObject({
      person_id: id("person_id"),
      provider_id: id("provider_id"),
      external_id: z
        .string({ error: "external_id is required" })
        .trim()
        .min(1, { error: "external_id is required" })
        .max(320)
        .transform((s) => (z.email().safeParse(s.toLowerCase()).success ? s.toLowerCase() : s)),
    })
    .superRefine((v, ctx) => {
      checkPerson(org, ctx, v.person_id, "person_id")
      checkProvider(org, ctx, v.provider_id)
      const clash = org.identities.find((i) => i.provider_id === v.provider_id && i.external_id === v.external_id)
      if (clash) {
        ctx.addIssue({
          code: "custom",
          path: ["external_id"],
          message: `Identity ${v.external_id} is already mapped for this provider`,
        })
      }
    })
}

// ---------------------------------------------------------------------------
// API keys and projects (upsert by provider + external id)
// ---------------------------------------------------------------------------

const externalId = (label: string) =>
  z.string({ error: `${label} is required` }).trim().min(1, { error: `${label} is required` }).max(255)

export function keyAssignSchema(org: Pick<OrgSnapshot, "people" | "teams" | "providers">) {
  return z
    .strictObject({
      provider_id: id("provider_id"),
      external_key_id: externalId("external_key_id"),
      name: optionalText(200),
      owner_person_id: nullableId("owner_person_id").optional(),
      team_id: nullableId("team_id").optional(),
    })
    .superRefine((v, ctx) => {
      checkProvider(org, ctx, v.provider_id)
      checkPerson(org, ctx, v.owner_person_id, "owner_person_id")
      checkTeam(org, ctx, v.team_id)
    })
}

export function projectAssignSchema(org: Pick<OrgSnapshot, "teams" | "providers">) {
  return z
    .strictObject({
      provider_id: id("provider_id"),
      external_project_id: externalId("external_project_id"),
      name: optionalText(200),
      team_id: nullableId("team_id").optional(),
    })
    .superRefine((v, ctx) => {
      checkProvider(org, ctx, v.provider_id)
      checkTeam(org, ctx, v.team_id)
    })
}

// ---------------------------------------------------------------------------
// Import from observed data
// ---------------------------------------------------------------------------

/** confirm !== true is a dry run. `emails` limits a confirmed import to a subset. */
export function importSchema(org: Pick<OrgSnapshot, "teams">) {
  return z
    .strictObject({
      confirm: z.boolean().optional(),
      emails: z.array(emailField).max(5000).optional(),
      team_id: nullableId("team_id").optional(),
    })
    .superRefine((v, ctx) => checkTeam(org, ctx, v.team_id))
}

// ---------------------------------------------------------------------------
// Unassigned queue one-click assign
// ---------------------------------------------------------------------------

export function unassignedAssignSchema(org: Pick<OrgSnapshot, "teams" | "providers">) {
  const team_id = id("team_id")
  return z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("person"), email: emailField, display_name: optionalText(200), team_id }),
      z.strictObject({
        kind: z.literal("api_key"),
        provider_id: id("provider_id"),
        external_key_id: externalId("external_key_id"),
        name: optionalText(200),
        team_id,
      }),
      z.strictObject({
        kind: z.literal("project"),
        provider_id: id("provider_id"),
        external_project_id: externalId("external_project_id"),
        name: optionalText(200),
        team_id,
      }),
    ])
    .superRefine((v, ctx) => {
      checkTeam(org, ctx, v.team_id)
      if (v.kind !== "person") checkProvider(org, ctx, v.provider_id)
    })
}

/** YYYY-MM month param. */
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: "month must be YYYY-MM" })
