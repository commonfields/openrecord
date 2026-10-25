// Credential encryption at rest: AES-256-GCM with deployment-managed keys.
// Ciphertext format: v1.<keyId>.<iv>.<ciphertext>.<tag> (base64url). The
// additional authenticated data binds a ciphertext to its connection and
// purpose, so a ciphertext copied to another row or field fails to decrypt.
// Several keys may be configured for rotation; the first one encrypts.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

export interface TokenCipher {
  readonly encrypt: (plaintext: string, context: string) => string
  /** Null when the ciphertext is malformed, its key is unknown or authentication fails. */
  readonly decrypt: (ciphertext: string, context: string) => string | null
  readonly activeKeyId: string
}
export const CIPHERTEXT_PATTERN = /^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$/

/** `GA4_TOKEN_ENCRYPTION_KEYS="k2:<base64 32 bytes>,k1:<base64 32 bytes>"`. Null when absent or malformed. */
export const parseCipherKeys = (raw: string | undefined): ReadonlyArray<{ readonly id: string; readonly key: Buffer }> | null => {
  if (!raw || !raw.trim()) return null
  const keys: Array<{ id: string; key: Buffer }> = []
  for (const entry of raw.split(",")) {
    const [id, value, ...rest] = entry.trim().split(":")
    if (!id || !value || rest.length || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || keys.some(k => k.id === id)) return null
    const key = Buffer.from(value, "base64")
    if (key.length !== 32) return null
    keys.push({ id, key })
  }
  return keys.length ? keys : null
}

export const makeTokenCipher = (keys: ReadonlyArray<{ readonly id: string; readonly key: Buffer }>): TokenCipher => {
  if (!keys.length) throw new Error("no encryption key")
  const active = keys[0]!
  const aad = (context: string) => Buffer.from(`openrecord:ga4:${context}`, "utf8")
  return {
    activeKeyId: active.id,
    encrypt: (plaintext, context) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", active.key, iv)
      cipher.setAAD(aad(context))
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
      return `v1.${active.id}.${iv.toString("base64url")}.${body.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`
    },
    decrypt: (ciphertext, context) => {
      if (!CIPHERTEXT_PATTERN.test(ciphertext)) return null
      const [, id, iv, body, tag] = ciphertext.split(".")
      const key = keys.find(k => k.id === id)
      if (!key) return null
      try {
        const decipher = createDecipheriv("aes-256-gcm", key.key, Buffer.from(iv!, "base64url"))
        decipher.setAAD(aad(context))
        decipher.setAuthTag(Buffer.from(tag!, "base64url"))
        return Buffer.concat([decipher.update(Buffer.from(body!, "base64url")), decipher.final()]).toString("utf8")
      } catch {
        return null
      }
    },
  }
}
