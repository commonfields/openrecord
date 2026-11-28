-- Sessions are found by the SHA-256 of the cookie token, never by the token
-- itself, so a copy of this table cannot be replayed as logins.
--
-- Until now the cookie was the row id. Those sessions keep working: their
-- digest is the digest of the id they were handed, and they expire within
-- 30 days. New sessions get a random token unrelated to the id.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS token_digest TEXT;
UPDATE sessions SET token_digest = encode(sha256(convert_to(id::text, 'UTF8')), 'hex') WHERE token_digest IS NULL;
ALTER TABLE sessions ALTER COLUMN token_digest SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_digest_key ON sessions (token_digest);
