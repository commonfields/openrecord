import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { DatePicker } from "../app/components/ui/date-picker"

describe("campaign controls use the application design system", () => {
  it("does not introduce browser-native dropdowns, date pickers or confirmation dialogs", () => {
    const source = readFileSync(new URL("../app/routes/campaigns.tsx", import.meta.url), "utf8")
    expect(source).not.toMatch(/<select\b|<option\b|type=["']date["']|window\.(confirm|alert|prompt)\(/)
    expect(source).toContain("<CampaignSelect")
    expect(source).toContain("<ConfirmDialog")
    expect(source).toContain("<DatePicker")
  })
  it("renders a styled calendar trigger with an accessible date label", () => {
    const html = renderToStaticMarkup(<DatePicker label="Launch date" value="2026-11-05" onChange={() => undefined} />)
    expect(html).toContain('aria-label="Launch date: 2026-11-05"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).not.toContain('type="date"')
  })
  it("provides an explicit empty date state", () => {
    const html = renderToStaticMarkup(<DatePicker label="Review date" value="" onChange={() => undefined} />)
    expect(html).toContain('aria-label="Review date: Choose date"')
    expect(html).not.toContain("Invalid Date")
  })
})
