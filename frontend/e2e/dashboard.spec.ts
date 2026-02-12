import { test, expect } from '@playwright/test'

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page, context }) => {
    // Mock authenticated session
    await context.addCookies([
      {
        name: 'sb-access-token',
        value: 'mock-token',
        domain: 'localhost',
        path: '/',
      },
    ])

    // Mock API responses
    await page.route('**/api/costs*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            { date: '2024-01-01', OpenAI: 50, Anthropic: 30, ChatGPT: 20 },
            { date: '2024-01-02', OpenAI: 55, Anthropic: 32, ChatGPT: 22 },
          ],
        }),
      })
    })
  })

  test('should load dashboard page', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()
  })

  test('should display KPI cards', async ({ page }) => {
    await page.goto('/dashboard')

    await expect(page.getByText(/this month/i)).toBeVisible()
    await expect(page.getByText(/yesterday/i)).toBeVisible()
    await expect(page.getByText(/forecast/i)).toBeVisible()
    await expect(page.getByText(/top model/i)).toBeVisible()
  })

  test('should display cost trend chart', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText(/cost trends/i)).toBeVisible()
    await expect(page.getByText(/daily costs by provider/i)).toBeVisible()
  })

  test('should display provider breakdown chart', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText(/provider breakdown/i)).toBeVisible()
    await expect(page.getByText(/total cost distribution/i)).toBeVisible()
  })

  test('should display forecast chart', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText(/cost forecast/i)).toBeVisible()
    await expect(page.getByText(/historical costs and 30-day predictions/i)).toBeVisible()
  })

  test('should display recent activity table', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByText(/recent activity/i)).toBeVisible()
  })

  test('should have working date range picker', async ({ page }) => {
    await page.goto('/dashboard')

    const datePicker = page.getByRole('button', { name: /pick a date range/i })
    await expect(datePicker).toBeVisible()

    await datePicker.click()
    // Calendar should be visible
    await expect(page.locator('[role="dialog"]')).toBeVisible()
  })

  test('should navigate to settings', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByRole('link', { name: /settings/i }).click()
    await expect(page).toHaveURL(/\/settings/)
  })

  test('should be responsive on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/dashboard')

    // Should still show main content
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()
    await expect(page.getByText(/this month/i)).toBeVisible()
  })
})
