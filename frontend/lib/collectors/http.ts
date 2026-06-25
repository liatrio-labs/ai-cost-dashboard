/**
 * Shared HTTP + parsing helpers for collectors.
 */

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * fetch with exponential backoff on 429 / 5xx. Returns the final Response
 * (the caller checks res.ok and reads the body). Non-retryable responses are
 * returned immediately.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: { maxRetries?: number; baseDelayMs?: number } = {}
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 500
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res: Response
    try {
      res = await fetch(url, { ...init, cache: "no-store" })
    } catch (err) {
      if (attempt < maxRetries) {
        await sleep(baseDelayMs * 2 ** attempt)
        attempt++
        continue
      }
      throw err
    }
    if (res.ok) return res
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      await sleep(baseDelayMs * 2 ** attempt)
      attempt++
      continue
    }
    return res
  }
}

/** Coerce an API amount (often a string) to a float, defaulting to 0. */
export function toFloat(value: unknown): number {
  const n = typeof value === "number" ? value : parseFloat(String(value))
  return Number.isFinite(n) ? n : 0
}

/** Coerce to integer, defaulting to 0. */
export function toInt(value: unknown): number {
  const n = parseInt(String(value), 10)
  return Number.isFinite(n) ? n : 0
}

/** "YYYY-MM-DD" for a Date in UTC. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** RFC3339 (UTC, trailing Z) for a Date. */
export function rfc3339(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z")
}

/** Unix seconds for a Date. */
export function unixSeconds(d: Date): number {
  return Math.floor(d.getTime() / 1000)
}
