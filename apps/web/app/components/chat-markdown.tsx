// An agent answer as formatted text, the way T3 Code's ChatMarkdown shows it:
// GitHub-flavoured Markdown (lists, tables, code, task lists) with the app's
// type scale. Raw HTML in the answer is never rendered, and links open in a
// new tab without passing this page as the opener.
import { memo } from "react"
import ReactMarkdown, { type Components } from "react-markdown"
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

export const ChatMarkdown = memo(function ChatMarkdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("chat-markdown min-w-0 text-base leading-relaxed break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{text}</ReactMarkdown>
    </div>
  )
})
