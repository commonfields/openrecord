// Agent answers as formatted Markdown (GFM), with safe links, syntax highlighting,
// and ```chart blocks rendered as in-app visuals. Streaming and fresh replies use
// @pierre/words fade-in instead of word-by-word slicing.
import "@pierre/words/styles.css"
import pierreDark from "@pierre/highlights/themes/pierre-dark"
import pierreLight from "@pierre/highlights/themes/pierre-light"
import { createHighlightsPlugin } from "@pierre/words/highlights"
import { Markdown, defaultUrlTransform, type Components } from "@pierre/words/react"
import { Fragment, memo, useMemo, useSyncExternalStore } from "react"
import { ChatVisual } from "@/components/chat-visual"
import { cn } from "@/lib/utils"

const CHART_OPEN = "```chart\n"
const LINK =
  ' class="font-medium text-primary-ink underline decoration-primary-ink/30 underline-offset-2 hover:decoration-primary-ink" target="_blank" rel="noopener noreferrer"'

const urlTransform = (url: string, key: "href" | "src") => {
  const safe = defaultUrlTransform(url)
  if (safe == null || safe === "") return safe
  if (key === "href" && !/^(https?:|mailto:)/i.test(safe)) return undefined
  if (key === "src") return undefined
  return safe
}

const wordsComponents: Components = {
  a: (html) => {
    if (!html.includes('href="')) return html.replace(/^<a\b[^>]*>/, "<span>").replace(/<\/a>\s*$/, "</span>")
    return html.replace("<a ", `<a${LINK} `)
  },
  table: (html) => `<div class="my-3 overflow-x-auto rounded-[10px] bg-card shadow-(--card-shadow)">${html}</div>`,
}

type Segment =
  | { kind: "md"; text: string }
  | { kind: "chart"; raw: string; open: boolean }

/** Split markdown around ```chart fences so charts stay React visuals. */
export function splitChartFences(text: string): Segment[] {
  const out: Segment[] = []
  let i = 0
  for (;;) {
    const at = text.indexOf(CHART_OPEN, i)
    if (at === -1) {
      if (i < text.length) out.push({ kind: "md", text: text.slice(i) })
      break
    }
    if (at > i) out.push({ kind: "md", text: text.slice(i, at) })
    const body = at + CHART_OPEN.length
    const close = text.indexOf("\n```", body)
    if (close === -1) {
      out.push({ kind: "chart", raw: text.slice(body), open: true })
      break
    }
    out.push({ kind: "chart", raw: text.slice(body, close), open: false })
    i = close + 4
  }
  return out.length ? out : [{ kind: "md", text }]
}

const subscribeDark = (onStore: () => void) => {
  const root = document.documentElement
  const obs = new MutationObserver(onStore)
  obs.observe(root, { attributes: true, attributeFilter: ["class"] })
  return () => obs.disconnect()
}
const darkSnapshot = () => document.documentElement.classList.contains("dark")
const darkServer = () => false

const codePlugins = new Map<boolean, ReturnType<typeof createHighlightsPlugin>>()
const codePlugin = (dark: boolean) => {
  let p = codePlugins.get(dark)
  if (!p) {
    p = createHighlightsPlugin({ theme: dark ? pierreDark : pierreLight })
    codePlugins.set(dark, p)
  }
  return p
}

export const ChatMarkdown = memo(function ChatMarkdown({
  text,
  className,
  live = false,
  reveal = false,
  onRevealEnd,
}: {
  text: string
  className?: string
  live?: boolean
  /** Fade in a complete reply (fresh agent message). */
  reveal?: boolean
  onRevealEnd?: () => void
}) {
  const dark = useSyncExternalStore(subscribeDark, darkSnapshot, darkServer)
  const plugins = useMemo(() => ({ code: codePlugin(dark) }), [dark])
  const segments = useMemo(() => splitChartFences(text), [text])
  const animating = live || reveal
  const animated = animating ? ({ animation: "fadeIn", duration: 180 } as const) : false

  return (
    <div className={cn("chat-markdown min-w-0 text-base leading-relaxed break-words", className)}>
      {segments.map((seg, i) =>
        seg.kind === "chart" ? (
          <ChatVisual key={i} raw={seg.raw} live={live && seg.open} />
        ) : seg.text ? (
          <Markdown
            key={i}
            mode={live ? "streaming" : "static"}
            isAnimating={animating}
            animated={animated}
            parseIncompleteMarkdown={live}
            lineNumbers={false}
            controls={false}
            components={wordsComponents}
            plugins={plugins}
            urlTransform={urlTransform}
            disallowedElements={["img"]}
            {...(reveal && !live && onRevealEnd ? { onAnimationEnd: onRevealEnd } : {})}
          >
            {seg.text}
          </Markdown>
        ) : (
          <Fragment key={i} />
        ),
      )}
    </div>
  )
})