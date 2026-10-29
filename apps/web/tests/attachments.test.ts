// Text files attached to a message: read in the browser, within the server's limits.
import { describe, expect, it } from "vitest"
import { addAttachments, MAX_FILE_CHARS, readAttachment } from "../app/lib/attachments"

const file = (name: string, text: string, type = "") => new File([text], name, { type })

describe("attachments", () => {
  it("reads text, CSV and Markdown files, and cuts long ones to the per-file limit", async () => {
    const csv = await readAttachment(file("leads.csv", "name,score\r\nA,1\r\n", "text/csv"))
    expect(csv).toEqual({ attachment: { name: "leads.csv", type: "text/csv", text: "name,score\nA,1\n" }, truncated: false })
    const long = await readAttachment(file("notes.md", "x".repeat(MAX_FILE_CHARS + 10)))
    expect("attachment" in long && long.attachment.text.length).toBe(MAX_FILE_CHARS)
    expect("attachment" in long && long.truncated).toBe(true)
  })

  it("refuses images, PDFs and empty files with a reason", async () => {
    expect(await readAttachment(file("logo.png", "x", "image/png"))).toMatchObject({ error: expect.stringContaining("images and PDFs") })
    expect(await readAttachment(file("deck.pdf", "x", "application/pdf"))).toMatchObject({ error: expect.stringContaining("images and PDFs") })
    expect(await readAttachment(file("empty.txt", "  "))).toMatchObject({ error: "empty.txt is empty." })
  })

  it("keeps at most three files and 80,000 characters together", () => {
    const f = (name: string, n: number) => ({ name, type: "text/plain", text: "x".repeat(n) })
    const { attachments, dropped } = addAttachments([f("a", 40000)], [f("b", 30000), f("c", 20000), f("d", 1)])
    expect(attachments.map(a => a.name)).toEqual(["a", "b", "d"])
    expect(dropped).toEqual(["c"])
  })
})
