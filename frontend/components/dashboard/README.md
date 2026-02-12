# Dashboard Components

This directory contains reusable dashboard components for the AI Cost Dashboard.

## Components

### MetricsCard
Displays KPI metrics with optional trend indicators.

**Props:**
- `title`: Card title
- `value`: Main metric value
- `change`: Percentage change (optional)
- `changeLabel`: Label for the change (optional)
- `icon`: React icon component (optional)
- `loading`: Loading state (optional)

**Usage:**
```tsx
<MetricsCard
  title="This Month"
  value="$2,525.90"
  change={12.5}
  changeLabel="from last month"
  icon={<DollarSign />}
/>
```

### DateRangePicker
Date range selection component using react-day-picker.

**Props:**
- `date`: DateRange object
- `onDateChange`: Callback for date changes
- `className`: Optional CSS classes

**Usage:**
```tsx
<DateRangePicker
  date={dateRange}
  onDateChange={setDateRange}
/>
```

### RecentActivityTable
Displays recent API usage in a table format.

**Props:**
- `activities`: Array of activity objects
- `loading`: Loading state (optional)

**Activity Object:**
- `id`: Unique identifier
- `timestamp`: ISO timestamp
- `provider`: Provider name
- `model`: Model name
- `cost`: Cost in USD
- `tokens`: Token count (optional)

### ErrorBoundary
React error boundary for graceful error handling.

**Props:**
- `children`: Child components
- `fallback`: Custom fallback UI (optional)

## Chart Components

Located in `/components/charts`:

### CostTimeSeriesChart
Stacked area chart showing costs over time by provider.

### ProviderBreakdownChart
Donut chart showing cost distribution by provider.

### ForecastChart
Line chart with historical data and predictions with confidence intervals.

## Color Scheme

- **OpenAI**: Emerald/Green
- **Anthropic**: Blue
- **ChatGPT**: Violet/Purple
