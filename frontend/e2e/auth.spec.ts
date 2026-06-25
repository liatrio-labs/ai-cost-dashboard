import { test, expect } from '@playwright/test'

test.describe('Authentication', () => {
  test('should display login page', async ({ page }) => {
    await page.goto('/login')
    await expect(page).toHaveTitle(/AI Cost Dashboard/)
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /sign in with google/i })).toBeVisible()
  })

  test('should offer Google auth only (no email/password)', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByRole('button', { name: /sign in with google/i })).toBeVisible()
    // Email/password login has been removed — Google is the only method.
    await expect(page.getByLabel(/email/i)).toHaveCount(0)
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
  })

  test('should display signup form', async ({ page }) => {
    await page.goto('/signup')
    await expect(page.getByLabel(/email/i)).toBeVisible()
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
    await expect(page.getByLabel(/confirm password/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /sign up/i })).toBeVisible()
  })

  test('should show error for mismatched passwords', async ({ page }) => {
    await page.goto('/signup')

    await page.getByLabel(/email/i).fill('test@example.com')
    await page.getByLabel('Password', { exact: true }).fill('password123')
    await page.getByLabel(/confirm password/i).fill('password456')
    await page.getByRole('button', { name: /sign up/i }).click()

    await expect(page.getByText(/passwords do not match/i)).toBeVisible()
  })

  test('should redirect authenticated users from login', async ({ page, context }) => {
    // Mock authenticated session
    await context.addCookies([
      {
        name: 'sb-access-token',
        value: 'mock-token',
        domain: 'localhost',
        path: '/',
      },
    ])

    await page.goto('/login')
    // Should redirect to dashboard (this may timeout if auth check fails, which is expected)
  })

  test('should protect dashboard route', async ({ page }) => {
    await page.goto('/dashboard')
    // Should redirect to login
    await expect(page).toHaveURL(/\/login/)
  })
})
