# ChatGPT Manual Cost Entry

This page allows users to manually track ChatGPT usage costs since ChatGPT doesn't provide a public API for programmatic cost tracking.

## Features

### 1. Manual Entry Form

Add individual cost entries with:
- **Date** - When the cost was incurred (date picker, max: today)
- **Cost (USD)** - Amount spent (numeric, positive values only)
- **Model** - ChatGPT model used (e.g., gpt-4, gpt-3.5-turbo)
- **Notes** (Optional) - Additional context or description

**Validation**:
- All required fields validated with Zod schema
- Date cannot be in the future
- Cost must be positive number
- Inline error messages with ARIA support

### 2. CSV Import

Bulk import historical costs via CSV file upload:

**Supported Format**:
```csv
date,cost,model,notes
2026-02-11,5.50,gpt-4,Project work
2026-02-10,3.25,gpt-3.5-turbo,Research
2026-02-09,8.00,gpt-4,Client demo
```

**Requirements**:
- Must have header row with columns: `date`, `cost`, `model`
- Optional `notes` column
- Date format: `YYYY-MM-DD`
- Cost: positive number
- Maximum 1000 entries per upload

**Validation**:
- File type must be `.csv`
- Parses and validates each row
- Shows error message with line number if validation fails
- Bulk uploads to `/api/costs/manual` endpoint

### 3. Historical View

Table showing recent manual entries (last 90 days):

**Columns**:
- Date
- Model (badge)
- Cost (formatted currency)
- Notes
- Source (Manual vs CSV badge)
- Actions (Delete button)

**Features**:
- Sortable by date (newest first)
- Limit 500 entries
- Empty state when no entries
- Loading skeletons during data fetch

### 4. Export to CSV

Download all entries as CSV file:
- Button visible when entries exist
- Exports date, cost, model, notes
- Filename: `chatgpt-costs-YYYY-MM-DD.csv`
- Success toast notification

### 5. Summary Stats

Card showing:
- **Total Entries** - Count of manual records
- **Total Cost** - Sum of all costs
- **Average Cost** - Mean cost per entry

## Components

### `page.tsx`
Main ChatGPT cost tracking page.

**Responsibilities**:
- Fetch ChatGPT provider ID
- Query cost records via TanStack Query
- Handle delete mutations
- Export to CSV functionality
- Render form and historical table

**Queries**:
- `["providers"]` - Fetch all providers, find ChatGPT
- `["cost-records", "chatgpt", providerId]` - Fetch last 90 days of manual entries

### `ManualEntryForm.tsx`
Reusable form component for manual entry and CSV upload.

**Props**:
- `providerId: string` - ChatGPT provider UUID
- `onSuccess?: () => void` - Callback after successful submission

**Features**:
- React Hook Form with Zod validation
- Date picker (HTML5 date input)
- CSV file parsing and validation
- Toast notifications for success/error
- Accessibility (ARIA labels, keyboard navigation)

**API Integration**:
- `POST /api/costs/manual` - Single entry
- `POST /api/costs/manual` - Bulk entries (with `entries` array)

### `toast.tsx`
Toast notification system (created for this feature).

**Types**:
- `success` - Green
- `error` - Red
- `warning` - Yellow
- `info` - Blue

**Usage**:
```typescript
const { showToast } = useToast()
showToast("success", "Entry saved!", 5000) // 5 second duration
```

## User Flow

### Adding Single Entry

1. User navigates to `/dashboard/chatgpt`
2. Fills out manual entry form (date, cost, model, notes)
3. Clicks "Add Entry" button
4. Form validates inputs
5. POST to `/api/costs/manual`
6. Success toast shown
7. Form resets
8. Historical table refreshes via query invalidation

### Importing CSV

1. User clicks "Upload CSV" button
2. Selects `.csv` file from file picker
3. Component reads file content
4. Parses CSV and validates each row
5. POST bulk entries to `/api/costs/manual`
6. Success toast with count (e.g., "Successfully imported 50 entries")
7. Historical table refreshes

### Viewing History

1. Page loads, fetches cost records for last 90 days
2. Table displays entries, newest first
3. User can see date, model, cost, notes, source
4. Empty state if no entries exist

### Deleting Entry

1. User clicks trash icon on entry
2. Confirmation dialog appears
3. User confirms deletion
4. DELETE mutation executed (TODO: implement endpoint)
5. Success toast shown
6. Table refreshes

## API Integration

### Endpoints Used

**POST /api/costs/manual** (Single Entry)
```json
{
  "provider_id": "uuid",
  "timestamp": "2026-02-11T12:00:00Z",
  "model_name": "gpt-4",
  "cost_usd": 5.50,
  "metadata": {
    "notes": "Project work",
    "entry_type": "manual_form"
  }
}
```

**POST /api/costs/manual** (Bulk CSV Import)
```json
{
  "entries": [
    {
      "provider_id": "uuid",
      "timestamp": "2026-02-11T12:00:00Z",
      "model_name": "gpt-4",
      "cost_usd": 5.50,
      "metadata": {
        "notes": "...",
        "entry_type": "csv_import"
      }
    }
  ]
}
```

**GET /api/costs**
```
?startDate=2025-11-13T00:00:00Z
&endDate=2026-02-11T23:59:59Z
&providers=chatgpt-provider-uuid
&granularity=hour
&limit=500
```

## Accessibility

### ARIA Support

- All form inputs have `aria-label` or associated `<Label>`
- Required fields marked with `aria-required="true"`
- Invalid fields have `aria-invalid="true"` and `aria-describedby` pointing to error message
- Error messages have `role="alert"` for screen reader announcements
- Action buttons have descriptive `aria-label` (e.g., "Delete entry from Feb 11, 2026")

### Keyboard Navigation

- All interactive elements keyboard accessible
- Form submission via Enter key
- Delete button accessible via Tab + Enter
- File upload button accessible (custom label triggers hidden input)

### Color Contrast

- Error messages in red (sufficient contrast)
- Success toasts in green
- Focus indicators visible on all interactive elements

## Error Handling

### Form Validation Errors

- Inline error messages below each field
- Red border on invalid fields
- Clear, actionable error text

### API Errors

- Network failures caught and shown in toast
- 400/401/500 errors parsed and displayed
- Generic fallback message if error parsing fails

### CSV Parsing Errors

- Invalid file type rejected before parsing
- Row-by-row validation with line numbers in error messages
- Maximum entry limit enforced (1000)

## Future Enhancements

### Coming Soon

1. **Edit Functionality** - Modify existing entries in-place
2. **Delete API Endpoint** - Implement backend DELETE route
3. **Recurring Reminders** - Optional notifications to log costs weekly
4. **Filtering** - Filter historical view by date range, model, cost range
5. **Search** - Search notes field
6. **Pagination** - For users with >500 entries
7. **Batch Actions** - Select multiple entries to delete
8. **Cost Breakdown** - Chart showing costs over time
9. **Model Statistics** - Most used models, average cost per model

### Potential Features

- **Auto-fill from OpenAI Billing** - Browser extension to scrape billing page
- **Receipt Upload** - OCR to extract cost from screenshots
- **Duplicate Detection** - Warn if entering same date/cost/model combination
- **Budget Alerts** - Notify when monthly costs exceed threshold
- **Export Formats** - JSON, Excel in addition to CSV

## Testing

### Manual Testing Checklist

- [ ] Add single entry with all fields
- [ ] Add entry with optional notes field empty
- [ ] Try to add entry with future date (should fail)
- [ ] Try to add entry with negative cost (should fail)
- [ ] Try to add entry with missing model (should fail)
- [ ] Upload valid CSV file
- [ ] Upload CSV with invalid date format (should fail)
- [ ] Upload CSV with missing required column (should fail)
- [ ] Upload CSV with >1000 entries (should fail)
- [ ] Upload non-CSV file (should fail)
- [ ] View historical entries table
- [ ] Export entries to CSV
- [ ] Delete an entry (when implemented)
- [ ] Check accessibility with keyboard only
- [ ] Check accessibility with screen reader

### Integration Testing

```typescript
// TODO: Add Playwright E2E tests
describe("ChatGPT Manual Entry", () => {
  it("should add a manual entry", () => {})
  it("should import CSV file", () => {})
  it("should display historical entries", () => {})
  it("should export to CSV", () => {})
  it("should delete an entry", () => {})
})
```

## Troubleshooting

### Issue: CSV Upload Does Nothing

**Cause**: File input might not trigger onChange
**Solution**: Click "Upload CSV" button again, or refresh page

### Issue: Entries Not Showing in Table

**Cause**: Query might be filtered incorrectly
**Solution**: Check provider_id matches ChatGPT, verify date range includes entries

### Issue: Delete Button Doesn't Work

**Cause**: DELETE endpoint not yet implemented
**Solution**: Delete functionality coming soon, shows error toast for now

### Issue: Toast Notifications Not Appearing

**Cause**: ToastProvider not wrapped around app
**Solution**: Verify `layout.tsx` includes `<ToastProvider>`

## Performance

- Table limited to 500 most recent entries (last 90 days)
- CSV parsing done on client-side (offload from backend)
- Query caching via TanStack Query (5 minute default)
- Optimistic updates for delete mutations
- Lazy loading of table rows (React virtualization if needed)

## Security

- All entries scoped to authenticated user (RLS)
- CSV parsing sanitizes input (no script injection)
- File size limits enforced (max ~1MB CSV)
- Rate limiting on API endpoints (TODO: add middleware)

---

For questions or issues, see:
- API Routes: `/app/api/README.md`
- Database Schema: `/database/README.md`
- Component Library: Shadcn UI docs
