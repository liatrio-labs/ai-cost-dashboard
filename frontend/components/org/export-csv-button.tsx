"use client"

/**
 * Issue #50: "Export CSV" for a table. The CSV is built on click from the
 * rows the table currently renders (filters and sort applied) and saved in
 * the browser; nothing goes to the server.
 */

import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { buildCsv, downloadCsv, type CsvColumn } from "@/lib/csv"

export function ExportCsvButton<T>({
  filename,
  columns,
  rows,
  label,
}: {
  filename: string
  columns: CsvColumn<T>[]
  rows: readonly T[]
  /** Accessible name, so several buttons on a page stay distinct. */
  label: string
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      title={`Download ${rows.length} row${rows.length === 1 ? "" : "s"} as CSV`}
      onClick={() => downloadCsv(filename, buildCsv(columns, rows))}
    >
      <Download className="h-4 w-4" />
      Export CSV
    </Button>
  )
}
