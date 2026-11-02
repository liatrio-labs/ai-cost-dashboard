/**
 * zod validation for the admin org routes (issue #7).
 *
 * Shape checks are static; checks that need the current org (unknown ids,
 * duplicate team name in a department, duplicate email) come from
 * orgSchemas(org), which refines against a snapshot of the org tables. The
 * database constraints in migration 010 remain the backstop for races.
 */

import { z } from "zod"
import type { OrgData } from "./types"

const name = z.string().trim().min(1, "Name is required").max(200, "Name must be 200 characters or fewer")
const id = z.string().trim().min(1, "Id is required")
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: "Invalid email address" }))
  .refine((e) => e.length <= 320, "Email must be 320 characters or fewer")
const optionalText = z.string().trim().max(2000).nullable().optional()

/** Nullable, but an empty string also means "none". */
const nullableId = z
  .union([id, z.null(), z.literal("")])
  .transform((v) => (v === "" ? null : v))

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

export function orgSchemas(org: OrgData) {
  const departmentIds = new Set(org.departments.map((d) => d.id))
  const teamIds = new Set(org.teams.map((t) => t.id))
  const personIds = new Set(org.people.map((p) => p.id))

  const knownDepartment = (v: string | null | undefined) => v == null || departmentIds.has(v)
  const knownTeam = (v: string | null | undefined) => v == null || teamIds.has(v)
  const knownPerson = (v: string | null | undefined) => v == null || personIds.has(v)

  const departmentId = nullableId.refine(knownDepartment, "Unknown department id")
  const teamId = nullableId.refine(knownTeam, "Unknown team id")
  const personId = nullableId.refine(knownPerson, "Unknown person id")

  const departmentNameTaken = (n: string, exceptId?: string) =>
    org.departments.some((d) => d.id !== exceptId && sameName(d.name, n))

  const teamNameTaken = (n: string, deptId: string | null, exceptId?: string) =>
    org.teams.some((t) => t.id !== exceptId && (t.department_id ?? null) === deptId && sameName(t.name, n))

  const emailTaken = (e: string, exceptId?: string) => org.people.some((p) => p.id !== exceptId && p.email === e)

  const departmentCreate = z
    .object({ name, description: optionalText })
    .refine((v) => !departmentNameTaken(v.name), { message: "A department with this name already exists", path: ["name"] })

  const departmentUpdate = (deptId: string) =>
    z
      .object({ name: name.optional(), description: optionalText })
      .refine((v) => v.name === undefined || !departmentNameTaken(v.name, deptId), {
        message: "A department with this name already exists",
        path: ["name"],
      })

  const teamCreate = z
    .object({ name, department_id: departmentId.optional().transform((v) => v ?? null) })
    .refine((v) => !teamNameTaken(v.name, v.department_id), {
      message: "A team with this name already exists in this department",
      path: ["name"],
    })

  const teamUpdate = (teamIdValue: string) => {
    const current = org.teams.find((t) => t.id === teamIdValue)
    return z
      .object({ name: name.optional(), department_id: departmentId.optional() })
      .refine(
        (v) => {
          const n = v.name ?? current?.name
          const dept = v.department_id === undefined ? (current?.department_id ?? null) : v.department_id
          return !n || !teamNameTaken(n, dept, teamIdValue)
        },
        { message: "A team with this name already exists in this department", path: ["name"] }
      )
  }

  const personCreate = z
    .object({
      email,
      display_name: z.string().trim().max(200).nullable().optional(),
      team_id: teamId.optional().transform((v) => v ?? null),
      active: z.boolean().optional(),
    })
    .refine((v) => !emailTaken(v.email), { message: "A person with this email already exists", path: ["email"] })

  const personUpdate = (personIdValue: string) =>
    z
      .object({
        email: email.optional(),
        display_name: z.string().trim().max(200).nullable().optional(),
        team_id: teamId.optional(),
        active: z.boolean().optional(),
      })
      .refine((v) => v.email === undefined || !emailTaken(v.email, personIdValue), {
        message: "A person with this email already exists",
        path: ["email"],
      })

  const identityCreate = z
    .object({
      person_id: id.refine((v) => personIds.has(v), "Unknown person id"),
      provider_id: id,
      external_id: z.string().trim().min(1, "External id is required").max(320),
    })
    .refine(
      (v) => !org.identities.some((i) => i.provider_id === v.provider_id && i.external_id === v.external_id),
      { message: "This provider identity is already mapped", path: ["external_id"] }
    )

  /** Upsert by (provider_id, external_key_id). Omitted fields are left as they are. */
  const apiKeyAssign = z.object({
    provider_id: id,
    external_key_id: z.string().trim().min(1, "Key id is required").max(255),
    name: z.string().trim().max(200).nullable().optional(),
    owner_person_id: personId.optional(),
    team_id: teamId.optional(),
  })

  const apiKeyUpdate = z.object({
    name: z.string().trim().max(200).nullable().optional(),
    owner_person_id: personId.optional(),
    team_id: teamId.optional(),
  })

  const unassignedAssign = z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("person"),
      email,
      display_name: z.string().trim().max(200).nullable().optional(),
      team_id: id.refine((v) => teamIds.has(v), "Unknown team id"),
    }),
    z.object({
      kind: z.literal("api_key"),
      provider_id: id,
      external_key_id: z.string().trim().min(1).max(255),
      name: z.string().trim().max(200).nullable().optional(),
      team_id: id.refine((v) => teamIds.has(v), "Unknown team id"),
    }),
  ])

  return {
    departmentCreate,
    departmentUpdate,
    teamCreate,
    teamUpdate,
    personCreate,
    personUpdate,
    identityCreate,
    apiKeyAssign,
    apiKeyUpdate,
    unassignedAssign,
  }
}

/** Import from observed data: a dry run unless confirm is true. */
export const importPeopleSchema = z.object({
  confirm: z.boolean().optional().default(false),
  /** Only create these emails (default: every observed email with no person). */
  emails: z.array(email).optional(),
  team_id: z.string().trim().min(1).nullable().optional(),
  days: z.number().int().min(1).max(3650).optional(),
})

export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM")

export const lookbackDaysSchema = z.coerce.number().int().min(1).max(3650)
