/**
 * Test-only in-memory stand-in for the Supabase service-role client, covering
 * the query-builder subset the /api/admin/org routes use. Enforces the unique
 * keys from migration 010 (Postgres error 23505) and logs every mutation so
 * tests can assert what was (or wasn't) written.
 */

type Row = Record<string, unknown>
type Filter = (row: Row) => boolean

export interface FakeCall {
  table: string
  op: "insert" | "update" | "upsert" | "delete"
  payload?: unknown
}

/** Unique keys per table (migration 010). */
const UNIQUE: Record<string, string[][]> = {
  departments: [["name"]],
  teams: [["department_id", "name"]],
  people: [["email"]],
  person_identities: [["provider_id", "external_id"]],
  org_api_keys: [["provider_id", "external_key_id"]],
}

/** Read "metadata->attribution->>person_email" style paths, or a plain column. */
function getPath(row: Row, path: string): unknown {
  const parts = path.split(/->>?/).map((p) => p.trim())
  let v: unknown = row
  for (const p of parts) {
    if (v === null || v === undefined || typeof v !== "object") return undefined
    v = (v as Row)[p]
  }
  return v
}

let seq = 0
const newId = () => `fake-${++seq}`

class FakeQuery implements PromiseLike<{ data: unknown; error: unknown; count?: number }> {
  private filters: Filter[] = []
  private op: "select" | FakeCall["op"] = "select"
  private payload: Row[] = []
  private patch: Row = {}
  private upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
  private orderBy: { col: string; asc: boolean } | null = null
  private rangeBounds: [number, number] | null = null
  private mode: "many" | "single" | "maybeSingle" = "many"

  constructor(
    private db: FakeSupabase,
    private table: string
  ) {}

  select() {
    return this
  }
  insert(rows: Row | Row[]) {
    this.op = "insert"
    this.payload = Array.isArray(rows) ? rows : [rows]
    return this
  }
  upsert(rows: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = "upsert"
    this.payload = Array.isArray(rows) ? rows : [rows]
    this.upsertOpts = opts
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
  eq(col: string, value: unknown) {
    this.filters.push((r) => getPath(r, col) === value)
    return this
  }
  in(col: string, values: unknown[]) {
    this.filters.push((r) => values.includes(getPath(r, col)))
    return this
  }
  gte(col: string, value: string) {
    this.filters.push((r) => String(getPath(r, col)) >= value)
    return this
  }
  lt(col: string, value: string) {
    this.filters.push((r) => String(getPath(r, col)) < value)
    return this
  }
  not(col: string, op: string, value: unknown) {
    if (op !== "is" || value !== null) throw new Error(`fake: unsupported not(${op})`)
    this.filters.push((r) => {
      const v = getPath(r, col)
      return v !== null && v !== undefined
    })
    return this
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    this.orderBy = { col, asc: opts.ascending !== false }
    return this
  }
  range(from: number, to: number) {
    this.rangeBounds = [from, to]
    return this
  }
  single() {
    this.mode = "single"
    return this
  }
  maybeSingle() {
    this.mode = "maybeSingle"
    return this
  }

  then<A = { data: unknown; error: unknown }, B = never>(
    onFulfilled?: ((value: { data: unknown; error: unknown }) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onFulfilled, onRejected)
  }

  private matches(row: Row) {
    return this.filters.every((f) => f(row))
  }

  private conflict(table: Row[], candidate: Row, except?: Row): Row | undefined {
    for (const cols of UNIQUE[this.table] ?? []) {
      const hit = table.find(
        (r) => r !== except && cols.every((c) => (r[c] ?? null) === (candidate[c] ?? null))
      )
      if (hit) return hit
    }
    return undefined
  }

  private execute(): { data: unknown; error: unknown } {
    const rows = this.db.table(this.table)
    let result: Row[]
    const now = new Date().toISOString()
    const dup = { code: "23505", message: `duplicate key value violates unique constraint on ${this.table}` }

    if (this.op === "select") {
      result = rows.filter((r) => this.matches(r))
      if (this.orderBy) {
        const { col, asc } = this.orderBy
        result = [...result].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * (asc ? 1 : -1))
      }
      if (this.rangeBounds) result = result.slice(this.rangeBounds[0], this.rangeBounds[1] + 1)
    } else if (this.op === "insert" || this.op === "upsert") {
      this.db.calls.push({ table: this.table, op: this.op, payload: this.payload })
      result = []
      for (const p of this.payload) {
        const row: Row = { id: newId(), created_at: now, updated_at: now, ...p }
        const hit = this.conflict(rows, row)
        if (hit) {
          if (this.op === "upsert" && this.upsertOpts.ignoreDuplicates) continue
          if (this.op === "upsert") {
            Object.assign(hit, p, { updated_at: now })
            result.push(hit)
            continue
          }
          return { data: null, error: dup }
        }
        rows.push(row)
        result.push(row)
      }
    } else if (this.op === "update") {
      this.db.calls.push({ table: this.table, op: "update", payload: this.patch })
      result = rows.filter((r) => this.matches(r))
      for (const r of result) {
        if (this.conflict(rows, { ...r, ...this.patch }, r)) return { data: null, error: dup }
        Object.assign(r, this.patch, { updated_at: now })
      }
    } else {
      this.db.calls.push({ table: this.table, op: "delete" })
      result = rows.filter((r) => this.matches(r))
      this.db.tables[this.table] = rows.filter((r) => !result.includes(r))
    }

    if (this.mode === "single") {
      if (result.length !== 1) return { data: null, error: { code: "PGRST116", message: "expected one row" } }
      return { data: result[0], error: null }
    }
    if (this.mode === "maybeSingle") return { data: result[0] ?? null, error: null }
    return { data: result, error: null }
  }
}

export class FakeSupabase {
  tables: Record<string, Row[]>
  calls: FakeCall[] = []

  constructor(seed: Record<string, object[]> = {}) {
    this.tables = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }) as Row)]))
  }

  table(name: string): Row[] {
    return (this.tables[name] ??= [])
  }

  from(name: string) {
    return new FakeQuery(this, name)
  }

  async rpc() {
    return { data: null, error: null }
  }

  /** Mutations, optionally for one table. */
  writes(table?: string) {
    return this.calls.filter((c) => !table || c.table === table)
  }
}
