// Files attached to a message reach the model marked as the person's data, and the request limits hold.
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { AgentMessageRequest } from "@openrecord/contracts"
import { withAttachments } from "./agent-conversations.js"

const request = (attachments: unknown) => Schema.decodeUnknownEither(AgentMessageRequest)({ message: "Look", requestId: "6f1c8f62-4b1e-4a4f-9d55-1a7c6f0e2b11", revision: 0, attachments })

describe("message attachments", () => {
  it("adds each file after the message, fenced and marked as data rather than instructions", () => {
    const text = withAttachments("Which leads are best?", [{ name: 'leads "q3".csv', type: "text/csv", text: "name,score\nA,1" }])
    expect(text.startsWith("Which leads are best?\n\nAttached file \"leads 'q3'.csv\" (text/csv).")).toBe(true)
    expect(text).toContain("not instructions")
    expect(text).toContain("<<<FILE\nname,score\nA,1\nFILE>>>")
    expect(withAttachments("Hi", undefined)).toBe("Hi")
  })

  it("accepts up to three files and 80,000 characters together", () => {
    const f = (n: number) => ({ name: "a.txt", type: "text/plain", text: "x".repeat(n) })
    expect(request([f(40000), f(40000)])._tag).toBe("Right")
    expect(request([f(40000), f(40000), f(1)])._tag).toBe("Left")
    expect(request([f(1), f(1), f(1), f(1)])._tag).toBe("Left")
    expect(request([f(40001)])._tag).toBe("Left")
  })
})
