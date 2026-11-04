import { buildCsv, csvField, csvFilename, downloadCsv, type CsvColumn } from "./csv"

describe("csvField (issue #50)", () => {
  it("leaves plain text alone", () => {
    expect(csvField("Ada Lovelace")).toBe("Ada Lovelace")
  })

  it("quotes commas, quotes and newlines, doubling inner quotes", () => {
    expect(csvField("Smith, Jane")).toBe('"Smith, Jane"')
    expect(csvField('the "prod" key')).toBe('"the ""prod"" key"')
    expect(csvField("line one\nline two")).toBe('"line one\nline two"')
    expect(csvField("a\r\nb")).toBe('"a\r\nb"')
    expect(csvField('"')).toBe('""""')
  })

  it("writes numbers unformatted", () => {
    expect(csvField(1234.5)).toBe("1234.5")
    expect(csvField(0)).toBe("0")
    expect(csvField(-12.25)).toBe("-12.25")
    expect(csvField(1234567.891)).toBe("1234567.891")
    expect(csvField(NaN)).toBe("")
    expect(csvField(Infinity)).toBe("")
  })

  it("writes null and undefined as empty, booleans as words", () => {
    expect(csvField(null)).toBe("")
    expect(csvField(undefined)).toBe("")
    expect(csvField(true)).toBe("true")
  })

  it("defuses text a spreadsheet would run as a formula, but not negative numbers", () => {
    expect(csvField("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"")
    expect(csvField("+1")).toBe("'+1")
    expect(csvField("-key")).toBe("'-key")
    expect(csvField("@sum")).toBe("'@sum")
    expect(csvField(-5)).toBe("-5")
  })
})

describe("buildCsv (issue #50)", () => {
  type Row = { name: string; spend: number; team: string | null }
  const columns: CsvColumn<Row>[] = [
    { header: "Name", value: (r) => r.name },
    { header: "Spend (USD)", value: (r) => r.spend },
    { header: "Team", value: (r) => r.team },
  ]

  it("writes a header and one CRLF line per row in the given order", () => {
    const rows: Row[] = [
      { name: "Zed, Z.", spend: 1500.75, team: null },
      { name: 'Ann "A" Lee', spend: 0.1, team: "Platform\nInfra" },
    ]
    const csv = buildCsv(columns, rows)
    expect(csv).toBe(['Name,Spend (USD),Team', '"Zed, Z.",1500.75,', '"Ann ""A"" Lee",0.1,"Platform\nInfra"'].join("\r\n"))
  })

  it("row count equals the rows passed, even with embedded newlines", () => {
    const rows: Row[] = Array.from({ length: 7 }, (_, i) => ({ name: `p${i}\nx`, spend: i, team: null }))
    const csv = buildCsv(columns, rows)
    expect(csv.split("\r\n")).toHaveLength(rows.length + 1)
  })

  it("writes only the header for no rows", () => {
    expect(buildCsv(columns, [])).toBe("Name,Spend (USD),Team")
  })
})

describe("csvFilename (issue #50)", () => {
  it("names a month period by its month", () => {
    expect(csvFilename("People", { start: "2026-11-01", end: "2026-11-30", mode: "month", selectedMonth: "2026-11" })).toBe(
      "ai-cost-people-2026-11.csv"
    )
  })

  it("names a range by its dates", () => {
    expect(csvFilename("API keys", { start: "2026-10-01", end: "2026-10-15", mode: "range", selectedMonth: null })).toBe(
      "ai-cost-api-keys-2026-10-01_to_2026-10-15.csv"
    )
  })

  it("says all-time with no period", () => {
    expect(csvFilename("Admin API keys", null)).toBe("ai-cost-admin-api-keys-all-time.csv")
  })
})

describe("downloadCsv (issue #50)", () => {
  it("clicks a download link for a CSV blob and frees the URL", () => {
    const create = jest.fn(() => "blob:csv")
    const revoke = jest.fn()
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("x.csv")
      expect(this.getAttribute("href")).toBe("blob:csv")
    })
    downloadCsv("x.csv", "a,b")
    expect(click).toHaveBeenCalledTimes(1)
    const blob = (create.mock.calls[0] as unknown[])[0] as Blob
    expect(blob.type).toBe("text/csv;charset=utf-8")
    expect(revoke).toHaveBeenCalledWith("blob:csv")
    expect(document.querySelector("a[download]")).toBeNull()
    click.mockRestore()
  })
})
