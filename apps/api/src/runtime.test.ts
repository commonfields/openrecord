import { describe, expect, it } from "vitest"
import { readStartupGit } from "./runtime.js"

// The API never runs git or reads .git; it reports what the launcher states.
describe("startup git metadata", () => {
  const commit = "a".repeat(40)
  it.each([["true", true], ["false", false], [undefined, null], ["maybe", null]] as const)("reports the launcher's commit with dirty=%s as %s", (flag, dirty) => {
    expect(readStartupGit({ OPENRECORD_BUILD_COMMIT: `${commit}\n`, OPENRECORD_BUILD_DIRTY: flag })).toEqual({ commitSha: commit, shortCommitSha: commit.slice(0, 12), dirtyAtStartup: dirty })
  })
  it("normalises case and accepts SHA-256 object names", () => {
    expect(readStartupGit({ OPENRECORD_BUILD_COMMIT: "B".repeat(64) }).commitSha).toBe("b".repeat(64))
  })
  it("reports unknown for a missing or malformed commit instead of guessing", () => {
    for (const value of [undefined, "", "not-a-commit", "a".repeat(39), `${commit}; rm -rf /`]) {
      expect(readStartupGit({ OPENRECORD_BUILD_COMMIT: value }).commitSha).toBeNull()
    }
  })
})
