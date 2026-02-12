# AI Cost Dashboard - User Guide

Welcome to the AI Cost Dashboard! This guide will help you get started tracking your AI API costs across multiple providers.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Adding API Keys](#adding-api-keys)
3. [Dashboard Overview](#dashboard-overview)
4. [Manual Cost Entry (ChatGPT)](#manual-cost-entry-chatgpt)
5. [Understanding Forecasts](#understanding-forecasts)
6. [Settings and Preferences](#settings-and-preferences)
7. [Troubleshooting](#troubleshooting)

---

## Getting Started

### Sign Up

1. Navigate to the AI Cost Dashboard homepage
2. Click **"Sign Up"** in the top right corner
3. Enter your email address and create a password
4. Click **"Create Account"**
5. Check your email for a verification link
6. Click the verification link to activate your account

### Log In

1. Go to the dashboard homepage
2. Click **"Log In"**
3. Enter your email and password
4. Click **"Sign In"**

You'll be redirected to your personalized dashboard!

---

## Adding API Keys

To start tracking costs automatically, you need to add your API keys for each provider.

### Anthropic (Claude API)

1. Go to **Settings** → **API Keys**
2. Click **"Add API Key"**
3. Select **"Anthropic"** from the provider dropdown
4. Enter a name for this key (e.g., "Production Key")
5. Paste your Anthropic API key (format: `sk-ant-api03-...`)
6. Click **"Save"**

**Where to find your Anthropic API key:**
- Visit [console.anthropic.com](https://console.anthropic.com/)
- Navigate to **API Keys** section
- Create a new key or use an existing one

**Note:** You need an **Admin API key** (not a regular API key) to access cost data automatically.

### OpenAI API

1. Go to **Settings** → **API Keys**
2. Click **"Add API Key"**
3. Select **"OpenAI"** from the provider dropdown
4. Enter a name for this key
5. Paste your OpenAI API key (format: `sk-proj-...` or `sk-...`)
6. Click **"Save"**

**Where to find your OpenAI API key:**
- Visit [platform.openai.com](https://platform.openai.com/api-keys)
- Click **"Create new secret key"**
- Copy the key (you won't be able to see it again)

### Security

- **API keys are encrypted** before storage using AES-256 encryption
- Keys are **never logged** or exposed in plain text
- Only the last 4 characters are shown in the UI (e.g., `***3456`)
- You can **revoke** keys at any time from the Settings page

---

## Dashboard Overview

Your dashboard provides a comprehensive view of your AI spending.

### KPI Cards (Top Row)

**Total This Month**
- Sum of all costs for the current month
- Updates in real-time as new data is collected

**Yesterday's Cost**
- Total spending from the previous day
- Useful for tracking daily trends

**30-Day Forecast**
- ML-predicted cost for the next 30 days
- Based on historical usage patterns
- Includes confidence intervals

**Top Model**
- The AI model you've used the most (by cost)
- Shows both model name and total cost

### Cost Trend Chart

Interactive line chart showing costs over time:
- **X-axis:** Date range (default: last 30 days)
- **Y-axis:** Cost in USD
- **Lines:** One per provider (color-coded)
- **Hover:** See exact costs for any date

**Customization:**
- **Date Range:** 7 days, 30 days, 90 days, or All time
- **Granularity:** Day, Week, or Month
- **Providers:** Filter by specific providers

### Provider Breakdown

Pie chart showing cost distribution by provider:
- **Anthropic** (Claude)
- **OpenAI** (GPT models)
- **ChatGPT** (manual entries)
- **Claude Desktop** (manual entries)

**Interactive:**
- Click a segment to see details
- Hover to see percentage breakdown

### Recent Activity Table

Recent cost entries with:
- **Date/Time** - When the cost was incurred
- **Provider** - Which AI service
- **Model** - Specific AI model used
- **Cost** - Amount in USD
- **Tokens** - Number of tokens used (if available)

**Actions:**
- Sort by clicking column headers
- Scroll to see more entries
- Export to CSV (coming soon)

---

## Manual Cost Entry (ChatGPT)

ChatGPT doesn't provide an API for cost tracking, so you can manually enter your costs.

### Navigate to ChatGPT Page

1. From the dashboard, click **"ChatGPT"** in the sidebar
2. Or navigate to `/dashboard/chatgpt`

### Add a Single Entry

1. Fill out the form:
   - **Date:** Select the date (can't be in the future)
   - **Cost (USD):** Enter the amount (e.g., 5.50)
   - **Model:** Enter the model used (e.g., gpt-4, gpt-3.5-turbo)
   - **Notes** (optional): Add any additional context
2. Click **"Add Entry"**
3. Success toast will appear
4. Entry appears in the historical table below

### Import from CSV

If you have historical data in a spreadsheet:

1. Create a CSV file with these columns:
   ```csv
   date,cost,model,notes
   2026-02-11,5.50,gpt-4,Project work
   2026-02-10,3.25,gpt-3.5-turbo,Research
   ```

2. Click **"Upload CSV"** button
3. Select your CSV file
4. Wait for processing (max 1000 entries)
5. Success toast shows number of imported entries

**CSV Requirements:**
- Must have header row: `date,cost,model` (notes optional)
- Date format: `YYYY-MM-DD`
- Cost: positive number
- File size: Max ~1MB

### View Historical Entries

The historical table shows:
- All your manual entries (last 90 days)
- Date, model, cost, notes, and source (Manual vs CSV)
- Delete button for each entry

### Export Your Data

1. Click **"Export CSV"** button at the top of the historical table
2. File downloads as `chatgpt-costs-YYYY-MM-DD.csv`
3. Open in Excel, Google Sheets, or any spreadsheet app

### Summary Stats

Below the table, see:
- **Total Entries:** Count of all manual records
- **Total Cost:** Sum of all costs
- **Average Cost:** Mean cost per entry

---

## Understanding Forecasts

The dashboard uses machine learning to predict your future costs.

### What is a Forecast?

A **forecast** is a prediction of how much you'll spend in the next 30 days based on:
- Your historical usage patterns
- Day-of-week trends (weekday vs weekend usage)
- Recent spending trajectory

### How It Works

1. **Data Collection:** The system collects your actual costs daily
2. **Model Training:** Prophet (Facebook's forecasting library) analyzes patterns
3. **Prediction:** Model generates 30-day forecast with confidence intervals
4. **Display:** Forecast appears as a shaded area on the cost chart

### Confidence Intervals

- **80% Interval:** Medium gray band - likely range
- **95% Interval:** Light gray band - very likely range
- **Forecast Line:** Dark line - most probable outcome

**Example:**
```
If the forecast shows $100 with:
- 80% interval: $80-$120
- 95% interval: $70-$130

This means:
- 80% chance your cost will be between $80-$120
- 95% chance your cost will be between $70-$130
```

### When Forecasts Update

- **Nightly:** Forecasts regenerate every night at 2 AM UTC
- **After 7 Days:** Need at least 7 days of data for reliable forecasts
- **Manual Trigger:** Click "Refresh Forecast" button (coming soon)

### Improving Forecast Accuracy

- **Add more data:** More historical data = better predictions
- **Consistent usage:** Stable patterns produce more accurate forecasts
- **Update regularly:** Keep API keys active for automatic data collection

### Limitations

- **New accounts:** Forecasts may be less accurate for first 2-3 weeks
- **Sudden changes:** Large usage spikes may temporarily skew predictions
- **Manual entries:** ChatGPT manual entries are included but may be incomplete

---

## Settings and Preferences

Customize your dashboard experience.

### API Keys Management

**View Keys:**
- Go to **Settings** → **API Keys**
- See all your stored API keys (masked for security)
- Check validation status (Valid, Invalid, Pending)

**Add Key:**
1. Click **"Add API Key"**
2. Select provider
3. Enter key name and API key
4. Click **"Save"**

**Revoke Key:**
1. Click the **trash icon** next to a key
2. Confirm deletion
3. Key is deactivated (not deleted, for audit trail)

**Validate Key:**
- System automatically validates keys on first use
- Invalid keys show error message
- Update key by adding a new one with the same name

### Display Preferences

**Theme:**
- **Light Mode:** Traditional light background
- **Dark Mode:** Easy on eyes, better for night use
- **System:** Matches your OS theme

**Currency:**
- Currently USD only
- More currencies coming soon

**Timezone:**
- Set your local timezone for accurate date displays
- Default: UTC

**Default Date Range:**
- Choose default view: 7d, 30d, 90d, or All
- Applied to charts and tables

### Notifications

**Email Notifications:**
- Budget alerts (coming soon)
- Weekly cost summary (coming soon)
- Forecast warnings (coming soon)

**Browser Notifications:**
- Currently disabled
- Coming in future update

---

## Troubleshooting

### Common Issues and Solutions

#### "No data available"

**Cause:** No API keys added, or data collection hasn't run yet.

**Solutions:**
1. Add API keys in Settings → API Keys
2. Wait 1 hour for first data collection
3. Check API key validation status
4. Verify API keys have correct permissions

#### "Invalid API key"

**Cause:** API key is incorrect or has been revoked.

**Solutions:**
1. Double-check the API key (copy it again from provider)
2. Ensure key has admin/billing permissions
3. Generate a new key from provider's console
4. Delete old key and add new one

#### "Forecast not available"

**Cause:** Not enough historical data.

**Solutions:**
1. Need at least 7 days of data for forecasts
2. Wait for automatic data collection
3. Add manual entries if using ChatGPT
4. Check that API keys are active and collecting data

#### Charts not loading

**Cause:** Network error or API timeout.

**Solutions:**
1. Refresh the page (Ctrl+R or Cmd+R)
2. Check internet connection
3. Try a different browser
4. Clear browser cache
5. Contact support if issue persists

#### CSV import fails

**Cause:** Invalid CSV format or too many entries.

**Solutions:**
1. Check CSV has correct columns: `date,cost,model`
2. Verify date format is `YYYY-MM-DD`
3. Ensure all costs are positive numbers
4. Limit to 1000 entries per upload
5. Check for special characters or encoding issues

#### Can't log in

**Cause:** Incorrect password or unverified email.

**Solutions:**
1. Click "Forgot Password" to reset
2. Check email for verification link (check spam folder)
3. Try different browser
4. Contact support for account recovery

#### Costs seem incorrect

**Cause:** Data collection lag, API rate limits, or manual entry errors.

**Solutions:**
1. Data updates hourly (Anthropic) or every 6 hours (OpenAI)
2. Check your provider's billing dashboard to compare
3. Review manual entries for typos
4. Wait 24 hours for data to sync
5. Contact support if discrepancies persist

### Getting Help

**In-App Support:**
- Click the **"?"** icon in the top right
- Access help articles and FAQs

**Email Support:**
- Send email to: support@ai-cost-dashboard.com (example)
- Include: account email, issue description, screenshots

**Community:**
- Join discussions on GitHub Issues
- Share feedback and feature requests

**Documentation:**
- Full docs: [docs.ai-cost-dashboard.com](https://docs.ai-cost-dashboard.com) (example)
- API Reference: `/docs/API.md`
- Developer Guide: `/docs/LOCAL_DEVELOPMENT.md`

---

## Tips and Best Practices

### Maximize Value

1. **Set up all providers:** Track costs comprehensively
2. **Add keys early:** Don't miss historical data
3. **Review weekly:** Check spending trends regularly
4. **Use forecasts:** Plan budgets proactively
5. **Export data:** Backup your cost history monthly

### Optimize Costs

1. **Monitor top models:** Identify expensive models
2. **Track by project:** Use notes field for cost allocation
3. **Compare providers:** Find the best value for your use case
4. **Set budgets:** Use forecasts to set monthly limits (coming soon)

### Security

1. **Use read-only keys:** If provider supports it
2. **Rotate keys:** Change API keys every 90 days
3. **Revoke unused keys:** Remove old or test keys
4. **Enable 2FA:** On your provider accounts
5. **Monitor access:** Review audit logs regularly

### Data Quality

1. **Consistent manual entries:** For ChatGPT, enter costs weekly
2. **Include notes:** Add context to manual entries
3. **Verify data:** Cross-check with provider billing occasionally
4. **Report issues:** Help improve accuracy by reporting bugs

---

## Keyboard Shortcuts

Speed up your workflow with keyboard shortcuts:

- **`/`** - Focus search (coming soon)
- **`Ctrl+,` / `Cmd+,`** - Open settings
- **`Ctrl+K` / `Cmd+K`** - Quick command menu (coming soon)
- **`?`** - Show keyboard shortcuts help

---

## Glossary

**API Key** - Secret token for authenticating with AI providers

**Cost Record** - Individual entry of AI usage cost

**Provider** - AI service company (Anthropic, OpenAI, etc.)

**Model** - Specific AI model (gpt-4, claude-3-opus, etc.)

**Forecast** - ML-predicted future costs

**Confidence Interval** - Range of likely forecast values

**Granularity** - Time resolution (hour, day, week, month)

**RLS** - Row-Level Security, ensures data privacy

**Token** - Unit of text processed by AI models

**Manual Entry** - Cost record added by user (not API)

---

## Changelog

### Version 1.0 (Current)

**Features:**
- Automatic cost tracking for Anthropic and OpenAI
- Manual entry for ChatGPT and Claude Desktop
- 30-day ML forecasts
- CSV import/export
- Multi-user support
- API key encryption

**Coming Soon:**
- Budget alerts and notifications
- Cost breakdown by project/tag
- More granular permissions
- Mobile app
- Slack integration

---

## Feedback and Feature Requests

We're constantly improving! Share your feedback:

1. **Feature Requests:** Open an issue on GitHub
2. **Bug Reports:** Include steps to reproduce
3. **General Feedback:** Email us or use in-app feedback form

Your input helps us build a better product!

---

**Need more help?** Check out:
- [API Documentation](/docs/API.md)
- [Developer Guide](/docs/LOCAL_DEVELOPMENT.md)
- [Deployment Guide](/docs/DEPLOYMENT.md)
- [Database Documentation](/database/README.md)
