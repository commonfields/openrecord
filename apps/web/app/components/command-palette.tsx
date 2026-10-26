// "Find…": one keyboard-first jump list for the workspace. F or ⌘K opens it;
// arrows move, Enter goes. Claims and facts load only while it is open.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router"
import {
  BookCheckIcon,
  Building2Icon,
  CornerDownLeftIcon,
  FileCheck2Icon,
  FlaskConicalIcon,
  GlobeIcon,
  InboxIcon,
  LayoutGridIcon,
  MessageSquareQuoteIcon,
  PlusIcon,
  RadarIcon,
  SearchIcon,
  SettingsIcon,
  TelescopeIcon,
} from "lucide-react"
import { Kbd } from "@/components/ui/kbd"
import { useSettings } from "@/components/settings-dialog"
import { IssueStateBadge } from "@/components/status"
import { Facts, Issues, type IssueState } from "@/lib/api"
import { groupClaims } from "@/lib/issues"
import { initial, markColor, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"

type Item = {
  id: string
  group: string
  label: string
  hint?: string
  icon: ReactNode
  keywords?: string
  badge?: IssueState
  run: () => void
}

const PaletteContext = createContext<{ open: () => void }>({ open: () => undefined })
export const useCommandPalette = () => useContext(PaletteContext)

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)
}

// The provider owns only state: the keyboard shortcut and open/close. It
// renders the search menu, and anything can trigger it via `useCommandPalette`.
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ctx = useMemo(() => ({ open: () => setOpen(true) }), [])
  const onClose = useMemo(() => () => setOpen(false), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) || (e.key.toLowerCase() === "f" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target))) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <PaletteContext.Provider value={ctx}>
      {children}
      <SearchMenu open={open} onClose={onClose} />
    </PaletteContext.Provider>
  )
}

// The search menu: a floating, non-modal menu anchored under the search bar,
// not one big modal frame. Its design is split into two separated cards —
// the query field, and the grouped results below it — and it knows nothing
// about who opens it or where it is mounted (callers pass open / onClose).
export function SearchMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null
  return <MenuSurface onClose={onClose} />
}

function MenuSurface({ onClose }: { onClose: () => void }) {
  const nav = useNavigate()
  const { businesses, activeBusiness } = useWorkspace()
  const { openSettings } = useSettings()
  const [q, setQ] = useState("")
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const bid = activeBusiness?.id ?? null
  const issues = useApi(bid ? `palette-issues:${bid}` : null, () => Issues.list(bid ?? ""))
  const facts = useApi(bid ? `palette-facts:${bid}` : null, () => Facts.list(bid ?? ""))

  const go = (to: string) => () => {
    onClose()
    nav(to)
  }

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    if (bid) {
      const base = `/businesses/${bid}`
      const pages: Array<[string, string, ReactNode, string]> = [
        ["Agent", "agent", <LayoutGridIcon key="i" />, "chat setup status plan report"],
        ["Channels", "channels", <GlobeIcon key="i" />, "connections integrations analytics ga4 github social"],
        ["Work", "work", <InboxIcon key="i" />, "initiatives approvals executions"],
        ["Results", "results", <LayoutGridIcon key="i" />, "today dashboard analytics overview"],
        ["AI answer issues", "issues", <InboxIcon key="i" />, "wrong claims inbox review"],
        ["Facts on the web", "representations", <GlobeIcon key="i" />, "representations sources drift in sync"],
        ["Approved facts", "truth", <BookCheckIcon key="i" />, "truth facts approved"],
        ["AI answer checks", "checks", <RadarIcon key="i" />, "checks questions run"],
        ["Website checks", "search", <SearchIcon key="i" />, "search website seo findings"],
        ["Prospect research", "assay", <FlaskConicalIcon key="i" />, "assay prospect"],
        ["Discover sources", "representations/discovery", <TelescopeIcon key="i" />, "discovery scan"],
      ]
      for (const [label, path, icon, keywords] of pages) out.push({ id: `page:${path}`, group: activeBusiness?.name ?? "Workspace", label, icon, keywords, run: go(`${base}/${path}`) })
      out.push({ id: "action:check", group: "Actions", label: "Run a check", icon: <RadarIcon />, keywords: "ask ai question", run: go(`${base}/checks`) })
      const reviewNext = (issues.data?.issues ?? []).find((i) => i.state === "NEEDS_REVIEW")
      if (reviewNext) {
        out.push({
          id: "action:review",
          group: "Actions",
          label: "Review the next claim",
          hint: "Oldest answers wait longest",
          icon: <MessageSquareQuoteIcon />,
          run: go(`/observations/${reviewNext.observation_id}?claim=${reviewNext.claim_id}`),
        })
      }
    }
    out.push({ id: "action:new-business", group: "Actions", label: "New business", icon: <PlusIcon />, keywords: "set up add website", run: go("/start") })
    out.push({
      id: "action:settings",
      group: "Actions",
      label: "Settings",
      icon: <SettingsIcon />,
      run: () => {
        onClose()
        openSettings("general")
      },
    })
    out.push({ id: "page:clients", group: "Agency", label: "Clients", icon: <FileCheck2Icon />, keywords: "agency record share", run: go("/clients") })
    out.push({ id: "page:businesses", group: "Agency", label: "All businesses", icon: <Building2Icon />, run: go("/businesses") })
    for (const b of businesses) {
      if (b.id === bid) continue
      out.push({
        id: `business:${b.id}`,
        group: "Switch business",
        label: b.name,
        icon: <span className={`flex size-4 items-center justify-center rounded text-[0.5625rem] font-semibold ${markColor(b.name).bg} ${markColor(b.name).text}`}>{initial(b.name)}</span>,
        run: go(`/businesses/${b.id}/agent`),
      })
    }
    if (bid) {
      for (const g of groupClaims(issues.data?.issues ?? [], "frequent")) {
        const target = g.occurrences.find((o) => o.state !== "NEEDS_REVIEW") ?? g.latest
        out.push({
          id: `claim:${g.key}`,
          group: "Claims",
          label: g.text,
          hint: `${g.occurrences.length}×`,
          badge: g.state,
          icon: <MessageSquareQuoteIcon />,
          keywords: g.questions.join(" "),
          run: go(
            target.state === "NEEDS_REVIEW"
              ? `/observations/${target.observation_id}?claim=${target.claim_id}`
              : `/businesses/${bid}/issues/${target.claim_id}`,
          ),
        })
      }
      for (const f of (facts.data?.facts ?? []).filter((f) => f.status === "ACTIVE")) {
        out.push({
          id: `fact:${f.id}`,
          group: "Approved facts",
          label: `${sentenceCase(f.predicate)}: ${f.valueText}`,
          hint: `v${f.version}`,
          icon: <BookCheckIcon />,
          keywords: f.subject,
          run: go(`/businesses/${bid}/truth`),
        })
      }
    }
    return out
  }, [bid, activeBusiness?.name, businesses, issues.data, facts.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return items.filter((i) => i.group !== "Claims" && i.group !== "Approved facts").concat(items.filter((i) => i.group === "Claims").slice(0, 5))
    const words = needle.split(/\s+/)
    return items.filter((i) => {
      const hay = `${i.label} ${i.keywords ?? ""} ${i.group}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [items, q])

  useEffect(() => setIndex(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" })
  }, [index])

  const groups: Array<[string, Array<Item & { i: number }>]> = []
  filtered.forEach((item, i) => {
    const last = groups.at(-1)
    if (last && last[0] === item.group) last[1].push({ ...item, i })
    else groups.push([item.group, [{ ...item, i }]])
  })

  // Close when the user clicks anywhere outside the menu or its trigger.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t?.closest("[data-search-menu], [data-search-trigger]")) onClose()
    }
    document.addEventListener("mousedown", onDown)
    return () => document.removeEventListener("mousedown", onDown)
  }, [onClose])

  return (
    <div
      data-search-menu
      role="dialog"
      aria-label="Find in OpenRecord"
      className="fixed top-[12%] left-1/2 z-50 flex w-[calc(100%-1.5rem)] max-w-3xl -translate-x-1/2 flex-col gap-1.5"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault()
          onClose()
        } else if (e.key === "ArrowDown") {
          e.preventDefault()
          setIndex((x) => Math.min(filtered.length - 1, x + 1))
        } else if (e.key === "ArrowUp") {
          e.preventDefault()
          setIndex((x) => Math.max(0, x - 1))
        } else if (e.key === "Enter") {
          e.preventDefault()
          filtered[index]?.run()
        }
      }}
    >
      {/* The query field: its own card, detached from the menu below it */}
      <div className="flex items-center gap-2.5 rounded-lg border border-sidebar-border bg-sidebar px-3 text-sidebar-foreground shadow-(--float-shadow-strong)">
        <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder={activeBusiness ? `Find in ${activeBusiness.name}…` : "Find…"}
          className="h-11 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          aria-label="Find"
        />
        <Kbd>Esc</Kbd>
      </div>
      {/* The menu: a separate card of grouped results, hints in its own footer */}
      <div className="max-h-[min(32rem,70vh)] overflow-hidden rounded-lg border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-(--float-shadow-strong)">
        <div ref={listRef} className="max-h-[min(28rem,60vh)] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">Nothing matches &ldquo;{q}&rdquo;.</p>
          ) : (
            groups.map(([group, list]) => (
              <div key={group} className="pb-1">
                <div className="px-2.5 pt-2 pb-1 text-[0.625rem] font-medium text-muted-foreground">{group}</div>
                {list.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-index={item.i}
                    onMouseMove={() => setIndex(item.i)}
                    onClick={item.run}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                      index === item.i && "bg-sidebar-accent/70 text-sidebar-accent-foreground",
                    )}
                  >
                    {item.icon}
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.badge ? <IssueStateBadge state={item.badge} /> : null}
                    {item.hint ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{item.hint}</span> : null}
                    {index === item.i ? <CornerDownLeftIcon className="size-3.5!" /> : null}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-sidebar-border bg-sidebar-accent/40 px-4 py-2 text-[0.6875rem] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> open
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Kbd>F</Kbd> or <Kbd>⌘K</Kbd> anywhere
          </span>
        </div>
      </div>
    </div>
  )
}
