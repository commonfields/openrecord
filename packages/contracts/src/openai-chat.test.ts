import { describe, expect, it } from "vitest"
import { chatCompletionAnswer, chatCompletionRequest, chatMessages, chatModelIds } from "./openai-chat.js"

const tools = [{ name: "read_open_issues", description: "Read issues", parametersJsonSchema: { type: "object", properties: { limit: { type: "integer" } }, additionalProperties: false } }]

describe("OpenAI-compatible chat transcript", () => {
  it("maps calls and responses by position and drops thoughts", () => {
    const messages = chatMessages({ system: "sys", tools, contents: [
      { role: "user", parts: [{ text: "What is open?" }] },
      { role: "model", parts: [{ text: "thinking", thought: true }, { functionCall: { name: "read_open_issues", args: { limit: 2 } } }, { functionCall: { name: "read_growth_goal", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { name: "read_open_issues", response: { untrustedEvidence: { summary: "2 issues" } } } },
        { functionResponse: { name: "read_growth_goal", response: { error: "NOT_FOUND" } } }, { text: "runtime notice" }] },
      { role: "model", parts: [{ text: "Two issues." }] },
    ] })
    expect(messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "What is open?" },
      { role: "assistant", content: null, tool_calls: [
        { id: "call_1_0", type: "function", function: { name: "read_open_issues", arguments: '{"limit":2}' } },
        { id: "call_1_1", type: "function", function: { name: "read_growth_goal", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1_0", content: '{"untrustedEvidence":{"summary":"2 issues"}}' },
      { role: "tool", tool_call_id: "call_1_1", content: '{"error":"NOT_FOUND"}' },
      { role: "user", content: "runtime notice" },
      { role: "assistant", content: "Two issues." },
    ])
  })
  it("declares tools natively and omits them when there are none", () => {
    const request = chatCompletionRequest({ system: "s", contents: [], tools }, "claude-sonnet-5-5", { maxTokens: 2048 })
    expect(request).toMatchObject({ model: "claude-sonnet-5-5", stream: false, tool_choice: "auto", max_tokens: 2048,
      tools: [{ type: "function", function: { name: "read_open_issues", parameters: tools[0]!.parametersJsonSchema } }] })
    expect(chatCompletionRequest({ system: "s", contents: [], tools: [] }, "m")).not.toHaveProperty("tools")
  })
})

describe("chat completion answers", () => {
  const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
  it("returns tool calls with parsed arguments", () => {
    expect(chatCompletionAnswer({ model: "gpt-6.1-sol", usage, choices: [{ finish_reason: "tool_calls", message: { content: null,
      tool_calls: [{ id: "x", type: "function", function: { name: "read_issue", arguments: '{"claimId":"a"}' } }] } }] }))
      .toEqual({ kind: "tools", calls: [{ name: "read_issue", args: { claimId: "a" } }],
        usage: { model: "gpt-6.1-sol", promptTokens: 10, outputTokens: 4, thoughtTokens: null, totalTokens: 14 } })
  })
  it("returns trimmed text", () => {
    expect(chatCompletionAnswer({ choices: [{ finish_reason: "stop", message: { content: "  Done.  " } }] })).toMatchObject({ kind: "text", text: "Done." })
  })
  it.each([
    ["invalid argument JSON", { choices: [{ message: { tool_calls: [{ function: { name: "t", arguments: "{" } }] } }] }],
    ["non-object arguments", { choices: [{ message: { tool_calls: [{ function: { name: "t", arguments: "[1]" } }] } }] }],
    ["a truncated reply", { choices: [{ finish_reason: "length", message: { content: "Half" } }] }],
    ["an empty reply", { choices: [{ finish_reason: "stop", message: { content: "  " } }] }],
    ["no choices", { choices: [] }],
    ["too many calls", { choices: [{ message: { tool_calls: Array.from({ length: 7 }, () => ({ function: { name: "t", arguments: "{}" } })) } }] }],
  ])("refuses %s", (_, raw) => {
    expect(chatCompletionAnswer(raw)).toEqual({ kind: "malformed" })
  })
  it("lists model IDs", () => {
    expect(chatModelIds({ object: "list", data: [{ id: "claude-opus-5-5", owned_by: "anthropic" }, { id: "gpt-6-luna" }] }))
      .toEqual([{ id: "claude-opus-5-5", ownedBy: "anthropic" }, { id: "gpt-6-luna", ownedBy: null }])
    expect(chatModelIds({ data: "no" })).toBeNull()
  })
})
