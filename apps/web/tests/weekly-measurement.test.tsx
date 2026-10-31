// The "This week" measurement block: renders the goal-metric trend with
// labelled reporting coverage and gap language when days are missing.
// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, beforeAll } from "vitest"
import { WeeklyMeasurement } from "../app/components/weekly-brief"
import { PreferencesProvider } from "../app/lib/preferences"

type Day = { day: string; value: number | null; origin: "REAL" | "SYNTHETIC" | null; status: "OK" | "MISSING" | "UNAVAILABLE" | "CONFLICT" }

// jsdom has no ResizeObserver; recharts' ResponsiveContainer needs one to mount.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const data = (days: Day[]) => ({
  issues: null,
  representations: null,
  activeFacts: null,
  search: null,
  profile: null,
  opportunities: [],
  series: {
    businessId: "b1", metricDefinitionId: "d1", metricLabel: "Trial signups", definitionVersion: 1,
    sourceKind: "OPERATOR_AGGREGATE_EXPORT" as const, countingSemantics: "EVENT_COUNT", unit: "COUNT",
    timeZone: "UTC", start: days[0]?.day ?? "2026-10-23", end: days[days.length - 1]?.day ?? "2026-10-29", days, conflicts: [],
  },
  loading: { issues: false, representations: false, search: false, growth: false },
})

describe("weekly measurement", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
    // jsdom does not implement matchMedia; the theme context only asks for the
    // system's dark preference.
    ;(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = () =>
      ({ matches: false, media: "", addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList)
  })

  it("renders the labelled trend with reported coverage and gap language", () => {
    const days: Day[] = [
      { day: "2026-10-23", value: 41, origin: "SYNTHETIC", status: "OK" },
      { day: "2026-10-24", value: 37, origin: "SYNTHETIC", status: "OK" },
      { day: "2026-10-25", value: 38, origin: "SYNTHETIC", status: "OK" },
      { day: "2026-10-26", value: 42, origin: "SYNTHETIC", status: "OK" },
      { day: "2026-10-27", value: 42, origin: "SYNTHETIC", status: "OK" },
      { day: "2026-10-28", value: null, origin: null, status: "MISSING" },
      { day: "2026-10-29", value: 44, origin: "SYNTHETIC", status: "OK" },
    ]
    const markup = renderToStaticMarkup(
      <PreferencesProvider><WeeklyMeasurement data={data(days)} /></PreferencesProvider>,
    )
    expect(markup).toContain("Trial signups")
    expect(markup).toContain("6 of 7 days reported")
    expect(markup).toContain("Gaps are days without a reported measurement.")
    expect(markup).toContain("This trend does not establish what caused a change.")
  })

  it("stays quiet without conflict language when every day reported", () => {
    const days: Day[] = Array.from({ length: 7 }, (_, i) => ({
      day: `2026-10-2${i + 3}`, value: 40 + i, origin: "REAL" as const, status: "OK" as const,
    }))
    const markup = renderToStaticMarkup(
      <PreferencesProvider><WeeklyMeasurement data={data(days)} /></PreferencesProvider>,
    )
    expect(markup).toContain("7 of 7 days reported")
    expect(markup).not.toContain("Gaps are days")
  })

  it("shows the empty state before any goal measurements exist", () => {
    const markup = renderToStaticMarkup(
      <PreferencesProvider><WeeklyMeasurement data={data([])} /></PreferencesProvider>,
    )
    expect(markup).toContain("No goal measurements for the last 7 days")
  })
})
