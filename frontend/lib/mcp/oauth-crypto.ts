/**
 * Issue #94: sealed (encrypted + authenticated) OAuth artifacts, so the MCP
 * OAuth server needs no database tables. Client registrations, the in-flight
 * authorize request, authorization codes, access tokens and refresh tokens
 * are all AES-256-GCM blobs under a key derived from MCP_OAUTH_SECRET.
 *
 * Each blob carries a `typ` (a code can never be used as an access token,
 * and so on) and, except client ids, an `exp`. Opening fails closed: a
 * missing secret, tampering, a wrong typ or an expired blob all yield null.
 *
 * Server-only (node:crypto). The secret itself is never logged or returned.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto"

export type SealedType = "client" | "authreq" | "code" | "access" | "refresh"

const VERSION = "v1"
const MIN_SECRET_LENGTH = 32

export class OAuthConfigError extends Error {
  constructor() {
    super("MCP OAuth is not configured (MCP_OAUTH_SECRET must be set, at least 32 characters)")
    this.name = "OAuthConfigError"
  }
}

function secret(): string | null {
  const s = process.env.MCP_OAUTH_SECRET
  return s && s.length >= MIN_SECRET_LENGTH ? s : null
}

export function isOAuthConfigured(): boolean {
  return secret() !== null
}

/** One key per artifact type, so blobs can't be swapped across types even before the typ check. */
function keyFor(typ: SealedType): Buffer {
  const s = secret()
  if (!s) throw new OAuthConfigError()
  return createHash("sha256").update(`ai-cost-mcp:${VERSION}:${typ}:`).update(s).digest()
}

const b64url = (b: Buffer) => b.toString("base64url")

export function seal(typ: SealedType, payload: Record<string, unknown>): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", keyFor(typ), iv)
  const body = Buffer.from(JSON.stringify({ ...payload, typ }), "utf8")
  const ct = Buffer.concat([cipher.update(body), cipher.final()])
  return `${VERSION}.${b64url(Buffer.concat([iv, ct, cipher.getAuthTag()]))}`
}

/** The payload, or null if it is not a valid, unexpired blob of this type. Never throws. */
export function open<T extends Record<string, unknown>>(typ: SealedType, token: unknown, now: number = Date.now()): T | null {
  if (typeof token !== "string" || token.length > 16_384 || !token.startsWith(`${VERSION}.`)) return null
  try {
    const raw = Buffer.from(token.slice(VERSION.length + 1), "base64url")
    if (raw.length < 12 + 16 + 2) return null
    const iv = raw.subarray(0, 12)
    const tag = raw.subarray(raw.length - 16)
    const ct = raw.subarray(12, raw.length - 16)
    const decipher = createDecipheriv("aes-256-gcm", keyFor(typ), iv)
    decipher.setAuthTag(tag)
    const payload = JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8"))
    if (!payload || typeof payload !== "object" || payload.typ !== typ) return null
    if (typ !== "client" && !(typeof payload.exp === "number" && payload.exp * 1000 > now)) return null
    return payload as T
  } catch {
    return null
  }
}

/** PKCE S256: BASE64URL(SHA256(verifier)) === challenge, in constant time. */
export function verifyPkceS256(verifier: unknown, challenge: unknown): boolean {
  if (typeof verifier !== "string" || typeof challenge !== "string") return false
  // RFC 7636: 43-128 unreserved characters.
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  const expected = Buffer.from(createHash("sha256").update(verifier).digest("base64url"))
  const given = Buffer.from(challenge)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

export const nowSeconds = (now: number = Date.now()) => Math.floor(now / 1000)
