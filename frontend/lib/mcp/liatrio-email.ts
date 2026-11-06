/**
 * Issue #94: who may use the MCP server. Google's `hd=liatrio.com` is only a
 * hint to the account chooser, so the server checks the signed-in Supabase
 * user itself: a Google identity whose email is exactly one mailbox at
 * liatrio.com (no subdomain, no look-alike domain, no display-name wrapper).
 */

export const LIATRIO_DOMAIN = "liatrio.com"

const MAILBOX = /^[a-z0-9._%+-]+@liatrio\.com$/

/** The normalized address when it is exactly someone@liatrio.com, else null. */
export function liatrioEmail(email: unknown): string | null {
  if (typeof email !== "string") return null
  const e = email.trim().toLowerCase()
  if (e.length > 254 || !MAILBOX.test(e)) return null
  const local = e.slice(0, -("@" + LIATRIO_DOMAIN).length)
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null
  return e
}

export function isLiatrioEmail(email: unknown): boolean {
  return liatrioEmail(email) !== null
}

/** The slice of a Supabase user the check reads. */
export interface AuthUserLike {
  id?: string
  email?: string | null
  email_confirmed_at?: string | null
  app_metadata?: { provider?: string; providers?: string[] } | null
  identities?: { provider?: string; identity_data?: { email?: string; email_verified?: boolean } | null }[] | null
}

/**
 * The user's liatrio.com address when they signed in with Google, else null.
 * Requires a Google identity carrying the same @liatrio.com address, so an
 * email/password or other-provider account with a liatrio-looking email is
 * refused.
 */
export function liatrioGoogleEmail(user: AuthUserLike | null | undefined): string | null {
  if (!user) return null
  const email = liatrioEmail(user.email)
  if (!email) return null
  const google = (user.identities ?? []).find((i) => i?.provider === "google")
  if (!google) return null
  const identityEmail = google.identity_data?.email
  if (identityEmail !== undefined && liatrioEmail(identityEmail) !== email) return null
  if (google.identity_data?.email_verified === false) return null
  return email
}
