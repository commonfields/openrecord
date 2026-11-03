// An agent answer as formatted text: GitHub-flavoured Markdown (lists, tables, code, task lists) with the app's
// type scale. Raw HTML in the answer is never rendered, and links open in a
// new tab without passing this page as the opener.
import { isValidElement, memo, type ReactNode } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
import { ChatVisual } from "@/components/chat-visual"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"

const safeHref = (href: string | undefined) => href && /^(https?:|mailto:)/i.test(href) ? href : undefined

const components: Components = {
  a: ({ href, children }) => {
    const safe = safeHref(href)
    return safe
      ? <a href={safe} target="_blank" rel="noopener noreferrer" className="font-medium text-primary-ink underline decoration-primary-ink/30 underline-offset-2 hover:decoration-primary-ink">{children}</a>
      : <span>{children}</span>
  },
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-[10px] bg-card shadow-(--card-shadow)"><table className="w-full border-collapse text-sm">{children}</table></div>
  ),
  img: ({ alt }) => alt ? <span className="text-muted-foreground">[{alt}]</span> : null,
}

/** The ```chart block inside a <pre>, if this is one: its raw spec text. */
const chartSource = (children: ReactNode): string | null => {
  const child = Array.isArray(children) ? children[0] : children
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null
  if (!/\blanguage-chart\b/.test(child.props.className ?? "")) return null
  return String(child.props.children ?? "").trim()
}
// Charts while a reply is still being revealed show "Drawing chart…" instead of half-written JSON.
const withVisuals = (live: boolean): Components => ({
  ...components,
  pre: ({ children }) => {
    const chart = chartSource(children)
    return chart !== null ? <ChatVisual raw={chart} live={live} /> : <pre>{children}</pre>
  },
})
const SETTLED = withVisuals(false), LIVE = withVisuals(true)

export const ChatMarkdown = memo(function ChatMarkdown({ text, className, live = false }: { text: string; className?: string; live?: boolean }) {
  return (
    <div className={cn("chat-markdown min-w-0 text-base leading-relaxed break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={live ? LIVE : SETTLED} skipHtml>{text}</ReactMarkdown>
    </div>
  )
})
