// First-party auth: scrypt password hashing (Node crypto, well-maintained
// stdlib) + server-side sessions + HttpOnly SameSite=Lax cookies.
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto"
import { Effect } from "effect"

const KEY_LENGTH = 32

const formatHash = (salt: string, hash: Buffer) => `scrypt$16384$8$1$${salt}$${hash.toString("hex")}`

const parseHash = (stored: string) => {
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return null
  return { salt: parts[4] as string, hash: Buffer.from(parts[5] as string, "hex") }
}

const scryptAsync = (password: string, salt: string) =>
  Effect.async<Buffer, Error>((resume) => {
    scrypt(password, salt, KEY_LENGTH, (error, key) => resume(error ? Effect.fail(error) : Effect.succeed(key)))
  })

/** Synchronous hashing, for scripts and tests only; request handlers use `hashPasswordEffect`. */
export const hashPassword = (password: string): string => {
  if (password.length < 8) throw new Error("InvalidFactValue: password too short")
  const salt = randomBytes(16).toString("hex")
  return formatHash(salt, scryptSync(password, salt, KEY_LENGTH))
}

/** Synchronous verification, for scripts and tests only; request handlers use `verifyPasswordEffect`. */
export const verifyPassword = (password: string, stored: string): boolean => {
  const parsed = parseHash(stored)
  if (!parsed) return false
  const derived = scryptSync(password, parsed.salt, KEY_LENGTH)
  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash)
}

/** Hashes on libuv's thread pool, so a burst of sign-ups never stalls the event loop. */
export const hashPasswordEffect = (password: string) =>
  Effect.gen(function*() {
    if (password.length < 8) return yield* Effect.fail({ _tag: "PasswordTooShort" as const })
    const salt = randomBytes(16).toString("hex")
    return formatHash(salt, yield* Effect.orDie(scryptAsync(password, salt)))
  })

// Spent when the email has no account, so a missing account takes as long
// to refuse as a wrong password and response time does not reveal which
// emails are registered.
const DUMMY_SALT = randomBytes(16).toString("hex")

/** Verifies off the event loop. `stored` null still pays one scrypt and returns false. */
export const verifyPasswordEffect = (password: string, stored: string | null) =>
  Effect.gen(function*() {
    const parsed = stored === null ? null : parseHash(stored)
    const derived = yield* Effect.orDie(scryptAsync(password, parsed?.salt ?? DUMMY_SALT))
    return parsed !== null && derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash)
  })

export const SESSION_COOKIE = "or_session"

export const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(";")) {
    const i = part.indexOf("=")
    if (i === -1) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (!k) continue
    try {
      out[k] = decodeURIComponent(v)
    } catch {
      // A malformed escape in someone else's cookie must not fail the request.
      out[k] = v
    }
  }
  return out
}

export const sessionCookieHeader = (sessionId: string, secure: boolean): string =>
  `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax${
    secure ? "; Secure" : ""
  }; Max-Age=2592000`

export const clearedCookieHeader = (): string =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
