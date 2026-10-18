import { execFileSync } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readStartupGit } from "./runtime.js"

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }))
afterEach(() => vi.resetAllMocks())

describe("startup git metadata", () => {
  const commit = "a".repeat(40)
  it.each([true, false])("captures the commit and dirty state (%s) with bounded git calls", dirty => {
    vi.mocked(execFileSync).mockReturnValueOnce(commit).mockReturnValueOnce(dirty ? " M src/server.ts\n" : "")
    expect(readStartupGit()).toEqual({ commitSha: commit, shortCommitSha: commit.slice(0, 12), dirtyAtStartup: dirty })
    expect(execFileSync).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], expect.objectContaining({ timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }))
    expect(execFileSync).toHaveBeenCalledWith("git", ["status", "--porcelain", "--untracked-files=normal"], expect.objectContaining({ timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }))
  })
  it("discards unexpected git output", () => {
    vi.mocked(execFileSync).mockReturnValue("TEST unexpected output")
    expect(readStartupGit()).toEqual({ commitSha: null, shortCommitSha: null, dirtyAtStartup: null })
    expect(execFileSync).toHaveBeenCalledTimes(1)
  })
  it("fails soft without exposing errors if git is unavailable", () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("TEST private checkout path") })
    expect(readStartupGit()).toEqual({ commitSha: null, shortCommitSha: null, dirtyAtStartup: null })
  })
})
