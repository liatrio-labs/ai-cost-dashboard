/**
 * In-memory stand-in for the slice of the supabase-js query builder the admin
 * org routes use: from().select/insert/update/delete with eq / in / is / not /
 * gte / lt / order / range / limit / single, select projections including
 * `alias:col->json->>field`, unique constraints (23505) and rpc(). Test-only.
 */

type Row = Record<string, unknown>
type Filter = (row: Row) => boolean

export interface FakeError {
  code: string
  message: string
}

export interface FakeTableConfig {
  /** Column tuples that must be unique. NULLs compare equal (NULLS NOT DISTINCT) when nullsEqual. */
  unique?: { columns: string[]; nullsEqual?: boolean }[]
}

export const ORG_TABLE_CONFIG: Record<string, FakeTableConfig> = {
  departments: { unique: [{ columns: ["name"] }] },
  teams: { unique: [{ columns: ["department_id", "name"], nullsEqual: true }] },
  people: { unique: [{ columns: ["email"] }] },
  person_identities: { unique: [{ columns: ["provider_id", "external_id"] }] },
  org_api_keys: { unique: [{ columns: ["provider_id", "external_key_id"] }] },
  org_projects: { unique: [{ columns: ["provider_id", "external_project_id"] }] },
}

/** Read `col`, `col->a->>b` style paths. */
export function readPath(row: Row, path: string): unknown {
  const parts = path.split(/->>?/)
  let v: unknown = row[parts[0].trim()]
  for (const p of parts.slice(1)) {
    if (v === null || v === undefined || typeof v !== "object") return null
    v = (v as Row)[p.trim()]
  }
  return v === undefined ? null : v
}

function project(row: Row, columns: string): Row {
  const cols = columns.split(",").map((c) => c.trim()).filter(Boolean)
  if (cols.includes("*")) return { ...row }
  const out: Row = {}
  for (const c of cols) {
    const [alias, path] = c.includes(":") ? c.split(":").map((s) => s.trim()) : [null, c]
    const parts = path.split(/->>?/)
    out[alias ?? parts[parts.length - 1].trim()] = readPath(row, path)
  }
  return out
}

export class FakeSupabase {
  tables: Record<string, Row[]>
  config: Record<string, FakeTableConfig>
  /** Every mutating call, for assertions: { table, op, rows }. */
  writes: { table: string; op: "insert" | "update" | "delete"; rows: Row[] }[] = []
  rpcCalls: string[] = []
  /** Like PostgREST max-rows: cap every select at this many rows when set. */
  maxRows: number | null = null
  private seq = 0

  constructor(tables: Record<string, object[]> = {}, config: Record<string, FakeTableConfig> = ORG_TABLE_CONFIG) {
    this.tables = {}
    for (const [k, v] of Object.entries(tables)) this.tables[k] = v.map((r) => ({ ...(r as Row) }))
    this.config = config
  }

  table(name: string): Row[] {
    this.tables[name] ??= []
    return this.tables[name]
  }

  nextId(table: string) {
    this.seq += 1
    return `${table}-new-${this.seq}`
  }

  from(table: string) {
    return new FakeQuery(this, table)
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async rpc(name: string, _args?: Record<string, unknown>): Promise<{ data: unknown; error: FakeError | null }> {
    this.rpcCalls.push(name)
    return { data: null, error: null }
  }

  /** Returns the violated constraint, or null. */
  uniqueViolation(table: string, candidate: Row, ignoreId?: unknown): string | null {
    for (const u of this.config[table]?.unique ?? []) {
      const vals = u.columns.map((c) => candidate[c] ?? null)
      if (!u.nullsEqual && vals.some((v) => v === null)) continue
      const clash = this.table(table).some(
        (r) => r.id !== ignoreId && u.columns.every((c, i) => (r[c] ?? null) === vals[i])
      )
      if (clash) return `${table}_${u.columns.join("_")}_key`
    }
    return null
  }
}

type Op = "select" | "insert" | "update" | "delete"

class FakeQuery implements PromiseLike<{ data: unknown; error: FakeError | null; count?: number | null }> {
  private op: Op = "select"
  private columns = "*"
  private filters: Filter[] = []
  private orders: { col: string; asc: boolean }[] = []
  private rangeFrom: number | null = null
  private rangeTo: number | null = null
  private limitN: number | null = null
  private singleMode: "single" | "maybe" | null = null
  private payload: Row[] = []
  private patch: Row = {}
  private returning = false
  private countMode = false
  private head = false

  constructor(private db: FakeSupabase, private tableName: string) {}

  select(columns = "*", opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") this.columns = columns
    else this.returning = true
    this.columns = columns
    this.countMode = !!opts?.count
    this.head = !!opts?.head
    return this
  }
  insert(rows: Row | Row[]) {
    this.op = "insert"
    this.payload = Array.isArray(rows) ? rows : [rows]
    return this
  }
  update(patch: Row) {
    this.op = "update"
    this.patch = patch
    return this
  }
  delete() {
    this.op = "delete"
    return this
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => readPath(r, col) === val)
    return this
  }
  neq(col: string, val: unknown) {
    this.filters.push((r) => readPath(r, col) !== val)
    return this
  }
  in(col: string, vals: unknown[]) {
    this.filters.push((r) => vals.includes(readPath(r, col)))
    return this
  }
  is(col: string, val: null | boolean) {
    this.filters.push((r) => (readPath(r, col) ?? null) === val)
    return this
  }
  not(col: string, op: string, val: unknown) {
    if (op !== "is") throw new Error(`fake: not(${op}) unsupported`)
    this.filters.push((r) => (readPath(r, col) ?? null) !== val)
    return this
  }
  gte(col: string, val: string | number) {
    this.filters.push((r) => String(readPath(r, col)) >= String(val))
    return this
  }
  lt(col: string, val: string | number) {
    this.filters.push((r) => String(readPath(r, col)) < String(val))
    return this
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orders.push({ col, asc: opts?.ascending !== false })
    return this
  }
  range(from: number, to: number) {
    this.rangeFrom = from
    this.rangeTo = to
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this
  }
  single() {
    this.singleMode = "single"
    return this
  }
  maybeSingle() {
    this.singleMode = "maybe"
    return this
  }

  then<R1 = { data: unknown; error: FakeError | null }, R2 = never>(
    onfulfilled?: ((value: { data: unknown; error: FakeError | null; count?: number | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected)
  }

  private matching(): Row[] {
    return this.db.table(this.tableName).filter((r) => this.filters.every((f) => f(r)))
  }

  private finish(rows: Row[]): { data: unknown; error: FakeError | null; count?: number | null } {
    let out = rows
    for (const o of [...this.orders].reverse()) {
      out = [...out].sort((a, b) => {
        const av = readPath(a, o.col) as string
        const bv = readPath(b, o.col) as string
        if (av === bv) return 0
        return (av < bv ? -1 : 1) * (o.asc ? 1 : -1)
      })
    }
    const count = out.length
    if (this.rangeFrom !== null) out = out.slice(this.rangeFrom, (this.rangeTo ?? out.length - 1) + 1)
    if (this.limitN !== null) out = out.slice(0, this.limitN)
    if (this.db.maxRows !== null) out = out.slice(0, this.db.maxRows)
    const projected = out.map((r) => project(r, this.columns))
    if (this.head) return { data: null, error: null, count }
    if (this.singleMode) {
      if (projected.length !== 1 && !(this.singleMode === "maybe" && projected.length === 0)) {
        return { data: null, error: { code: "PGRST116", message: `expected 1 row, got ${projected.length}` } }
      }
      return { data: projected[0] ?? null, error: null }
    }
    return { data: projected, error: null, count: this.countMode ? count : null }
  }

  private execute() {
    const table = this.db.table(this.tableName)
    const now = new Date().toISOString()

    if (this.op === "select") return this.finish(this.matching())

    if (this.op === "insert") {
      const created: Row[] = []
      for (const p of this.payload) {
        const row: Row = { id: this.db.nextId(this.tableName), created_at: now, updated_at: now, ...p }
        const violated = this.db.uniqueViolation(this.tableName, row)
        if (violated) {
          // Statement is atomic: undo rows from this insert.
          for (const c of created) table.splice(table.indexOf(c), 1)
          return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${violated}"` } }
        }
        table.push(row)
        created.push(row)
      }
      this.db.writes.push({ table: this.tableName, op: "insert", rows: created.map((r) => ({ ...r })) })
      return this.returning ? this.finish(created) : { data: null, error: null }
    }

    if (this.op === "update") {
      const rows = this.matching()
      for (const r of rows) {
        const violated = this.db.uniqueViolation(this.tableName, { ...r, ...this.patch }, r.id)
        if (violated) {
          return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "${violated}"` } }
        }
      }
      for (const r of rows) Object.assign(r, this.patch, { updated_at: now })
      this.db.writes.push({ table: this.tableName, op: "update", rows: rows.map((r) => ({ ...r })) })
      return this.returning ? this.finish(rows) : { data: null, error: null }
    }

    const rows = this.matching()
    for (const r of rows) table.splice(table.indexOf(r), 1)
    this.db.writes.push({ table: this.tableName, op: "delete", rows: rows.map((r) => ({ ...r })) })
    return this.returning ? this.finish(rows) : { data: null, error: null }
  }
}
