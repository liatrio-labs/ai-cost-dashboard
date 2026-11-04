/**
 * Issue #50: CSV export of the dashboard tables (People, API keys, Projects)
 * and the /admin/org key list. Client-side only: the caller passes the rows
 * it renders (already filtered and sorted) and the columns it shows.
 *
 * RFC 4180: fields containing a comma, quote, CR or LF are quoted with inner
 * quotes doubled; lines end in CRLF. Numbers are written raw (no currency
 * symbol, no thousands separators), null/undefined as an empty field. Text
 * that a spreadsheet would run as a formula (leading = + - @, tab or CR) is
 * prefixed with a single quote.
 */

export type CsvValue = string | number | boolean | null | undefined

export interface CsvColumn<T> {
  header: string
  value: (row: T) => CsvValue
}

const NEEDS_QUOTES = /[",\r\n]/
const FORMULA_START = /^[=+\-@\t\r]/

/** One CSV field. */
export function csvField(v: CsvValue): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : ""
  if (typeof v === "boolean") return v ? "true" : "false"
  const s = FORMULA_START.test(v) ? `'${v}` : v
  return NEEDS_QUOTES.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** A header line plus one line per row, CRLF-separated, no trailing newline. */
export function buildCsv<T>(columns: CsvColumn<T>[], rows: readonly T[]): string {
  const line = (cells: CsvValue[]) => cells.map(csvField).join(",")
  return [line(columns.map((c) => c.header)), ...rows.map((r) => line(columns.map((c) => c.value(r))))].join("\r\n")
}

export interface CsvPeriod {
  start: string
  end: string
  mode?: "month" | "range"
  selectedMonth?: string | null
}

/**
 * e.g. "ai-cost-people-2026-11.csv" for a month, "ai-cost-api-keys-2026-10-01_to_2026-10-15.csv"
 * for a range, "ai-cost-admin-api-keys-all-time.csv" with no period.
 */
export function csvFilename(table: string, period: CsvPeriod | null): string {
  const label = !period
    ? "all-time"
    : period.mode === "month" && period.selectedMonth
      ? period.selectedMonth
      : `${period.start}_to_${period.end}`
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "")
  return `ai-cost-${slug(table)}-${slug(label)}.csv`
}

/** Saves the CSV in the browser. A UTF-8 BOM makes Excel read non-ASCII names correctly. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
