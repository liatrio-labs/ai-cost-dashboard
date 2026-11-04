# Current-period projections (issue #39)

Early in a month every trend used to compare a partial month with a full one, so on Nov 4
everything read as a 90%+ drop. The dashboard now projects the period that contains today and
compares that projection with the previous full period. The code is
`frontend/lib/projection.ts` (pure, unit-tested in `projection.test.ts`).

## Where it shows

| Place | Before | Now |
|---|---|---|
| KPI "Total Monthly Spend" change | period vs the preceding equal-length window | projected period vs the previous full period, "+0.7% projected", tooltip "Projected from N complete days (through …); actual to date $X" |
| Tools table Change | provider's period vs preceding window | provider's projected period vs previous full period |
| Org tables Change (department, team, person, API key, project) | `pctChange(cost, prevCost)` | `projectedChangePercent` (projected vs `prevCost`), shown as "… proj." under a "Change (projected)" header |
| Spend Trends | partial month plotted as a normal point | solid through the last complete month, dotted to the projected current month |
| Spend Forecast | dashed projection from the partial month, anchored on `max(last two months)` | dotted from the last complete month to the projected current month, then the saturating projection anchored on it |
| Team/department forecast | anchored on the unit's spend in the org's anchor month | anchored on the unit's projected current month (unit anchors sum to the org anchor) |
| Person/key/project forecast card | "No forecast for this view; trailing 3-month average …" (average included the partial month) | "Projected Nov 2026: $X (+0.7% vs Oct 2026); trailing 3-month average …" (average of complete months only) |

Past periods keep actual vs actual. Future periods (a future range) have no projection and no
change. Actual totals (`kpis.totalSpend`, `prevSpend`, `trends[].total`, every entity's `cost`
and `prevCost`, the breakdown `total`) are unchanged; projections are separate fields
(`projection.*` on both responses, `projectedSpend`/`projectedChangePercent` on tools rows,
`projectedCost`/`projectedChangePercent` on breakdown rows, `actualToDate` on the projected
forecast point). `lib/projection-totals-baseline.json` pins the actual totals captured from
main before this change.

## Method

Computed per entity (org, provider, department, team, person, key, project) from that
entity's rows, so it works under any filter. Within an entity, usage is projected per provider
and summed.

1. **Complete days.** A day is complete for a provider when its `providers.last_collected_at`
   is after the end of that day (UTC). Today is never complete. A provider with no
   `last_collected_at` (manual entry) counts as complete through yesterday. Rows on incomplete
   days count as actuals but don't drive the rate. Example (Nov 4 morning): Anthropic, Cursor,
   Claude.ai collected today are complete through Nov 3; OpenAI collected Nov 3 15:56 UTC is
   complete through Nov 2.
2. **Seats vs usage.** Rows dated the 1st from a monthly-seat provider (`chatgpt`,
   `claude-max`), or any row on the 1st with `model_name = 'seats'`, are seat spend.
   Everything else is usage.
3. **Usage.** For each remaining day of the period (after the provider's last complete day):
   `expected = w × period average for that day type + (1 − w) × trailing average for that day type`,
   day type = weekday or weekend (UTC), the period average over the period's complete days, the
   trailing average over the 28 complete days ending at the provider's last complete day, and
   `w = min(1, complete days in the period ÷ 14)`. A day type with no complete day in the period
   yet uses the trailing average alone, so on the 1st (no complete days) `w = 0`. A remaining day
   that already logged spend adds `max(0, expected − logged)`.
4. **Seats.** Seat rows already billed in the period count as they are. A provider that billed
   seats on the previous month's 1st but not yet on this month's is projected at last month's
   amount (e.g. ChatGPT Business's $900 manual row).
5. **Projected period** = every actual row in the period + projected usage + projected seats.
6. **Change.** `(projected − previous full period) ÷ previous full period`, one decimal. No
   previous spend gives `null`, shown as "new". Month mode compares with the previous calendar
   month; a custom range with the preceding equal-length window.

The "N complete days" in tooltips is for the least-complete provider in the view.

Day types and complete days use UTC dates, the same as `cost_records_daily`.
