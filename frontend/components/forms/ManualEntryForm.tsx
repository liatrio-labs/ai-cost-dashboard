"use client"

import * as React from "react"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { format } from "date-fns"
import { Calendar as CalendarIcon, Upload, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/components/ui/toast"

// Form validation schema
const manualEntrySchema = z.object({
  date: z.string().min(1, "Date is required"),
  cost: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
    message: "Cost must be a positive number",
  }),
  model: z.string().min(1, "Model is required"),
  notes: z.string().optional(),
})

type ManualEntryFormData = z.infer<typeof manualEntrySchema>

interface ManualEntryFormProps {
  providerId: string
  onSuccess?: () => void
}

export function ManualEntryForm({ providerId, onSuccess }: ManualEntryFormProps) {
  const { showToast } = useToast()
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [csvFile, setCsvFile] = React.useState<File | null>(null)
  const [csvParsing, setCsvParsing] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    setValue,
  } = useForm<ManualEntryFormData>({
    defaultValues: {
      date: format(new Date(), "yyyy-MM-dd"),
      cost: "",
      model: "gpt-4",
      notes: "",
    },
  })

  const onSubmit = async (data: ManualEntryFormData) => {
    setIsSubmitting(true)

    try {
      const response = await fetch("/api/costs/manual", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider_id: providerId,
          timestamp: new Date(data.date + "T12:00:00Z").toISOString(),
          model_name: data.model,
          cost_usd: parseFloat(data.cost),
          metadata: {
            notes: data.notes || "",
            entry_type: "manual_form",
          },
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Failed to save entry")
      }

      showToast("success", "Cost entry saved successfully!")
      reset()
      onSuccess?.()
    } catch (error: any) {
      showToast("error", error.message || "Failed to save cost entry")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCsvUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    if (!file.name.endsWith(".csv")) {
      showToast("error", "Please upload a CSV file")
      return
    }

    setCsvFile(file)
    setCsvParsing(true)

    try {
      const text = await file.text()
      const entries = parseCsvFile(text)

      if (entries.length === 0) {
        throw new Error("No valid entries found in CSV file")
      }

      if (entries.length > 1000) {
        throw new Error("Maximum 1000 entries allowed per upload")
      }

      // Upload bulk entries
      const response = await fetch("/api/costs/manual", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          entries: entries.map((entry) => ({
            provider_id: providerId,
            timestamp: new Date(entry.date + "T12:00:00Z").toISOString(),
            model_name: entry.model,
            cost_usd: entry.cost,
            metadata: {
              notes: entry.notes || "",
              entry_type: "csv_import",
            },
          })),
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Failed to import CSV")
      }

      const result = await response.json()
      showToast("success", `Successfully imported ${result.count} entries from CSV!`)
      setCsvFile(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
      onSuccess?.()
    } catch (error: any) {
      showToast("error", error.message || "Failed to process CSV file")
      setCsvFile(null)
    } finally {
      setCsvParsing(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Manual Entry Form */}
      <Card>
        <CardHeader>
          <CardTitle>Add Manual Entry</CardTitle>
          <CardDescription>
            Manually record your ChatGPT usage costs. Enter the date, cost, and model used.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Date Field */}
              <div className="space-y-2">
                <Label htmlFor="date">
                  Date <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="date"
                  type="date"
                  {...register("date")}
                  max={format(new Date(), "yyyy-MM-dd")}
                  className={errors.date ? "border-red-500" : ""}
                  aria-required="true"
                  aria-invalid={!!errors.date}
                  aria-describedby={errors.date ? "date-error" : undefined}
                />
                {errors.date && (
                  <p id="date-error" className="text-sm text-red-500" role="alert">
                    {errors.date.message}
                  </p>
                )}
              </div>

              {/* Cost Field */}
              <div className="space-y-2">
                <Label htmlFor="cost">
                  Cost (USD) <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="cost"
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  {...register("cost")}
                  className={errors.cost ? "border-red-500" : ""}
                  aria-required="true"
                  aria-invalid={!!errors.cost}
                  aria-describedby={errors.cost ? "cost-error" : undefined}
                />
                {errors.cost && (
                  <p id="cost-error" className="text-sm text-red-500" role="alert">
                    {errors.cost.message}
                  </p>
                )}
              </div>
            </div>

            {/* Model Field */}
            <div className="space-y-2">
              <Label htmlFor="model">
                Model <span className="text-red-500">*</span>
              </Label>
              <Input
                id="model"
                type="text"
                placeholder="gpt-4, gpt-3.5-turbo, etc."
                {...register("model")}
                className={errors.model ? "border-red-500" : ""}
                aria-required="true"
                aria-invalid={!!errors.model}
                aria-describedby={errors.model ? "model-error" : undefined}
              />
              {errors.model && (
                <p id="model-error" className="text-sm text-red-500" role="alert">
                  {errors.model.message}
                </p>
              )}
            </div>

            {/* Notes Field */}
            <div className="space-y-2">
              <Label htmlFor="notes">Notes (Optional)</Label>
              <Input
                id="notes"
                type="text"
                placeholder="Add any additional notes..."
                {...register("notes")}
              />
            </div>

            <Button type="submit" disabled={isSubmitting} className="w-full md:w-auto">
              {isSubmitting ? (
                "Saving..."
              ) : (
                <>
                  <Plus className="mr-2 h-4 w-4" />
                  Add Entry
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* CSV Import */}
      <Card>
        <CardHeader>
          <CardTitle>Import from CSV</CardTitle>
          <CardDescription>
            Upload a CSV file with date, cost, model, and notes columns. Maximum 1000 entries.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertDescription>
              <strong>CSV Format:</strong> Your CSV should have columns: <code>date</code>,{" "}
              <code>cost</code>, <code>model</code>, and optionally <code>notes</code>.
              <br />
              <strong>Example:</strong> <code>2026-02-11,5.50,gpt-4,Project work</code>
            </AlertDescription>
          </Alert>

          <div className="flex items-center gap-4">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              onChange={handleCsvUpload}
              className="hidden"
              id="csv-upload"
              aria-label="Upload CSV file"
            />
            <Label htmlFor="csv-upload" className="cursor-pointer">
              <Button
                type="button"
                variant="outline"
                disabled={csvParsing}
                onClick={() => fileInputRef.current?.click()}
                asChild
              >
                <span>
                  <Upload className="mr-2 h-4 w-4" />
                  {csvParsing ? "Processing..." : "Upload CSV"}
                </span>
              </Button>
            </Label>
            {csvFile && !csvParsing && (
              <span className="text-sm text-muted-foreground">{csvFile.name}</span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ============================================================================
// CSV Parsing Helper
// ============================================================================

interface CsvEntry {
  date: string
  cost: number
  model: string
  notes?: string
}

function parseCsvFile(csvText: string): CsvEntry[] {
  const lines = csvText.trim().split("\n")

  if (lines.length < 2) {
    throw new Error("CSV file must have a header row and at least one data row")
  }

  // Parse header
  const header = lines[0].split(",").map((col) => col.trim().toLowerCase())
  const dateIdx = header.findIndex((col) => col === "date")
  const costIdx = header.findIndex((col) => col === "cost")
  const modelIdx = header.findIndex((col) => col === "model")
  const notesIdx = header.findIndex((col) => col === "notes")

  if (dateIdx === -1 || costIdx === -1 || modelIdx === -1) {
    throw new Error("CSV must have 'date', 'cost', and 'model' columns")
  }

  // Parse data rows
  const entries: CsvEntry[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue // Skip empty lines

    const values = line.split(",").map((val) => val.trim())

    try {
      const date = values[dateIdx]
      const cost = parseFloat(values[costIdx])
      const model = values[modelIdx]
      const notes = notesIdx !== -1 ? values[notesIdx] : undefined

      // Validate date format (YYYY-MM-DD)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`Invalid date format on line ${i + 1}: ${date}`)
      }

      // Validate cost
      if (isNaN(cost) || cost <= 0) {
        throw new Error(`Invalid cost on line ${i + 1}: ${values[costIdx]}`)
      }

      // Validate model
      if (!model) {
        throw new Error(`Missing model on line ${i + 1}`)
      }

      entries.push({ date, cost, model, notes })
    } catch (error: any) {
      throw new Error(`Error parsing line ${i + 1}: ${error.message}`)
    }
  }

  return entries
}
