import { describe, expect, it } from "vitest"
import { taskTimes } from "./campaign-timeline.js"

const rev = (at: string, status: string) => ({ at, tasks: [{ id: "a", status }] })
describe("campaign timeline", () => {
  it("reads added, started and finished from saved revisions", () => {
    expect(taskTimes("a", [{ at: "2026-11-01", tasks: [] }, rev("2026-11-02", "TODO"), rev("2026-11-04", "IN_PROGRESS"), rev("2026-11-07", "DONE"), rev("2026-11-09", "DONE")]))
      .toMatchObject({ added: "2026-11-02", started: "2026-11-04", finished: "2026-11-07" })
  })
  it("treats reopened work as unfinished", () => {
    expect(taskTimes("a", [rev("1", "IN_PROGRESS"), rev("2", "DONE"), rev("3", "IN_PROGRESS")]).finished).toBeNull()
    expect(taskTimes("a", [rev("1", "IN_PROGRESS"), rev("2", "DONE"), rev("3", "TODO"), rev("4", "DONE")]).finished).toBe("4")
  })
  it("never invents a start, and takes the earliest recorded finish", () => {
    expect(taskTimes("a", [rev("1", "TODO"), rev("5", "DONE")])).toMatchObject({ started: null, finished: "5" })
    expect(taskTimes("a", [rev("1", "TODO"), rev("5", "DONE")], { started: "2", finished: "4" })).toMatchObject({ started: "2", finished: "4" })
    expect(taskTimes("a", [rev("1", "TODO"), rev("5", "DONE")], { started: "8" }).started).toBeNull()
    expect(taskTimes("a", [rev("1", "DONE"), rev("2", "DONE")]).finished).toBeNull()
    expect(taskTimes("gone", [rev("1", "TODO")]).added).toBeNull()
  })
})
