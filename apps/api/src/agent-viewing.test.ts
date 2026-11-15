// The artifacts open beside the chat reach the model as app context, the front one named as the target.
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { AgentMessageRequest } from "@openrecord/contracts"
import { withViewing } from "./agent-conversations.js"

const FRONT = "6f1c8f62-4b1e-4a4f-9d55-1a7c6f0e2b11"
const OTHER = "0b7e1d2c-3f4a-4b5c-8d6e-7f8091a2b3c4"
const request = (viewing: unknown) => Schema.decodeUnknownEither(AgentMessageRequest)({ message: "Make the header navy", requestId: FRONT, revision: 0, viewing })

describe("open artifacts", () => {
  it("names the front artifact as the one a change applies to, and lists the others", () => {
    const text = withViewing("Make the header navy", { artifacts: [FRONT, OTHER] })
    expect(text.startsWith("Make the header navy\n\n[App context, not written by the person:")).toBe(true)
    expect(text).toContain(`it is for artifact ${FRONT}`)
    expect(text).toContain(`also open: ${OTHER}`)
    expect(text).toContain("edit_artifact")
  })

  it("leaves the message alone when nothing is open", () => {
    expect(withViewing("Hi", undefined)).toBe("Hi")
    expect(withViewing("Hi", { artifacts: [] })).toBe("Hi")
  })

  it("accepts one to eight artifact ids and nothing else", () => {
    expect(request({ artifacts: [FRONT] })._tag).toBe("Right")
    expect(request({ artifacts: [] })._tag).toBe("Left")
    expect(request({ artifacts: ["not-an-id"] })._tag).toBe("Left")
    expect(request({ artifacts: Array(9).fill(FRONT) })._tag).toBe("Left")
  })
})
