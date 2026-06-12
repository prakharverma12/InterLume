import { test, expect } from '@playwright/test'
import path from 'path'

test('full pipeline: upload → process → download without error', async ({ page }) => {
  await page.goto('/')

  // Force MOBILE tier so WebGPU is not required (WASM fallback, int8 model, batchSize 1)
  await page.getByRole('button', { name: /Mobile/i }).click()

  // Upload test fixture (works even on the hidden file input)
  await page.locator('input[type="file"]').setInputFiles(
    path.resolve('tests/fixtures/test.mp4')
  )

  // Click the start button (enabled after a file is selected)
  await page.getByRole('button', { name: /Generate/i }).click()

  // Wait for either success (download button) or error banner — whichever comes first
  const result = await Promise.race([
    page.locator('[data-testid="download-btn"]').waitFor({ timeout: 180_000 })
         .then(() => 'success'),
    page.locator('[data-testid="error-banner"]').waitFor({ timeout: 180_000 })
         .then(async () => {
           const msg = await page.locator('[data-testid="error-banner"]').textContent()
           return `error: ${msg}`
         }),
  ])

  // Capture full log for diagnostics on failure
  const log = await page.locator('[data-testid="log"]').textContent().catch(() => '')
  if (result !== 'success') {
    console.error('=== WORKER LOG ===\n' + log)
  }

  expect(result).toBe('success')
})
