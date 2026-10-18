import { useEffect, useState } from "react"

// Google supplies the search-suggestion widget with grounded answers.
// Keep provider HTML in an opaque sandbox, with no scripts, same-origin
// access, forms, resource fetches, or navigation of the containing record.
//
// Google's markup is shown unmodified. The wrapper only:
// - declares `color-scheme: light dark`, so the frame follows the app theme
//   (the iframe inherits the page's color scheme) and its canvas stays
//   transparent instead of painting an opaque white box in dark mode;
// - sets `<base target="_blank">` (no href, so `base-uri 'none'` still holds),
//   so a chip opens Google Search in a new tab. Google refuses to be framed,
//   so following the link inside the frame only shows a connection error;
// - removes the default body margin and keeps 1px for the widget's outline;
// - scales the whole frame by the reader's root font size (like browser
//   zoom): the widget is sized in px while the app is sized in rem, so a
//   smaller default font would otherwise leave the widget oversized.
// The widget is one row: 8px padding + a 32px chip + 8px padding = 48px.
const HEIGHT = 50

function useRootScale() {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
    if (Number.isFinite(root) && root > 0) setScale(root / 16)
  }, [])
  return scale
}

export function SearchSuggestions({ html }: { html: string | null }) {
  const scale = useRootScale()
  if (!html) return null
  const policy = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
  const frame = <iframe title="Google Search suggestions" className="block w-full border-0 bg-transparent" style={{ height: HEIGHT }}
    sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer"
    srcDoc={`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><base target="_blank"><style>html,body{margin:0;background:transparent;overflow:hidden}body{padding:1px}</style></head><body>${html}</body></html>`} />
  if (scale === 1) return frame
  return (
    <div className="overflow-hidden" style={{ height: HEIGHT * scale }}>
      <div style={{ width: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: "0 0" }}>{frame}</div>
    </div>
  )
}
