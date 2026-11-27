import { describe, expect, it } from "vitest"
import { databaseName, refusal } from "./database-guard.js"

describe("integration database guard", () => {
  it("refuses the development database under either variable", () => {
    expect(refusal({ TEST_DATABASE_URL: "postgres://u:p@localhost:5432/openrecord_dev" })).toContain("TEST_DATABASE_URL")
    expect(refusal({ DATABASE_URL: "postgres://u:p@localhost:5432/openrecord_dev?sslmode=disable" })).toContain("DATABASE_URL")
  })
  it("allows throwaway and CI databases, and no database at all", () => {
    expect(refusal({ TEST_DATABASE_URL: "postgres://u:p@localhost:5432/openrecord_test_20261126" })).toBeNull()
    expect(refusal({ TEST_DATABASE_URL: "postgres://u:p@localhost:5432/openrecord" })).toBeNull()
    expect(refusal({})).toBeNull()
    expect(databaseName("not a url")).toBeNull()
  })
})
