import { describe, expect, it } from "vitest"
import { asksForPiece } from "./agent.js"

describe("asksForPiece", () => {
  it("recognises requests for a piece of writing", () => {
    for (const m of ["Write an FAQ section for our pricing page.", "Draft a cold email to agencies", "Rewrite our homepage headline", "Write three LinkedIn posts announcing our product", "Write an X thread that introduces us"])
      expect(asksForPiece(m), m).toBe(true)
  })
  it("leaves questions and analysis alone", () => {
    for (const m of ["How are we doing against our goal?", "Who are our closest competitors?", "Can you turn off the weekly brief?", "Which page should we fix first?"])
      expect(asksForPiece(m), m).toBe(false)
  })
})
