import "@pierre/words/styles.css"
import pierreDark from "@pierre/highlights/themes/pierre-dark"
import pierreLight from "@pierre/highlights/themes/pierre-light"
import { createHighlightsPlugin } from "@pierre/words/highlights"
import { Markdown, defaultUrlTransform, type Components } from "@pierre/words/react"
import { useMemo } from "react"

const LINK =
  ' class="message-link" style="font-weight:500;color:var(--primary-ink);text-decoration:underline;text-underline-offset:2px" target="_blank" rel="noopener noreferrer"'

const urlTransform = (url: string, key: "href" | "src") => {
  const safe = defaultUrlTransform(url)
  if (safe == null || safe === "") return safe
  if (key === "href" && !/^(https?:|mailto:)/i.test(safe)) return undefined
  if (key === "src") return undefined
  return safe
}

const components: Components = {
  a: (html) => {
    if (!html.includes('href="')) return html.replace(/^<a\b[^>]*>/, "<span>").replace(/<\/a>\s*$/, "</span>")
    return html.replace("<a ", `<a${LINK} `)
  },
  table: (html) => `<div style="overflow-x:auto;margin:0.75rem 0;border-radius:10px">${html}</div>`,
}

const codePlugins = new Map<boolean, ReturnType<typeof createHighlightsPlugin>>()
const codePlugin = (dark: boolean) => {
  let p = codePlugins.get(dark)
  if (!p) {
    p = createHighlightsPlugin({ theme: dark ? pierreDark : pierreLight })
    codePlugins.set(dark, p)
  }
  return p
}

export function ChatMarkdown({
  text,
  live = false,
  reveal = false,
}: {
  text: string
  live?: boolean
  reveal?: boolean
}) {
  const plugins = useMemo(() => ({ code: codePlugin(document.documentElement.classList.contains("dark")) }), [])
  const animating = live || reveal
  const animated = animating ? ({ animation: "fadeIn", duration: 180 } as const) : false

  return (
    <Markdown
      mode={live ? "streaming" : "static"}
      isAnimating={animating}
      animated={animated}
      parseIncompleteMarkdown={live}
      lineNumbers={false}
      controls={false}
      components={components}
      plugins={plugins}
      urlTransform={urlTransform}
      disallowedElements={["img"]}
    >
      {text}
    </Markdown>
  )
}