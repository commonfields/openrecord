import { createContext, useContext, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { Link, Outlet, useLocation, useMatch, useNavigate } from "react-router"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  BookCheckIcon,
  BriefcaseIcon,
  ChevronDownIcon,
  RadioTowerIcon,
  Building2Icon,
  FlaskConicalIcon,
  CheckIcon,
  CheckCheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  GlobeIcon,
  InboxIcon,
  KeyboardIcon,
  LogOutIcon,
  MessagesSquareIcon,
  PanelLeftIcon,
  PlusIcon,
  RadarIcon,
  SearchIcon,
  SettingsIcon,
  UserRoundIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { NewChatDialog } from "@/components/new-chat-dialog"
import { CommandPaletteProvider, useCommandPalette } from "@/components/command-palette"
import { HeaderSlotContext } from "@/components/page"
import { sectionTitles } from "@/lib/nav"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSettings } from "@/components/settings-dialog"
import { rememberedEmail, usePreferences } from "@/lib/preferences"
import { Agent, Auth, DECISIONS_CHANGED, Decisions } from "@/lib/api"
import { toast } from "sonner"
import { initial, markColor, relativeTime } from "@/lib/format"
import { ChatActivityProvider, chatPath, notifyAgentChats, useAgentChats, useArchivedChats, type MergedChat } from "@/lib/agent-chats"
import { ProviderLogo } from "@/components/provider-logo"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"
import { Records, type ClientSummary } from "@/lib/record"

type SidebarState = { collapsed: boolean; inSheet: boolean }
const SidebarStateContext = createContext<SidebarState>({ collapsed: false, inSheet: false })

// Lets page content (e.g. an agent chat) adjust the shell: hide the header's
// breadcrumbs, take the full height to lay out its own scrolling panes
// (workspace), use the full width of any screen instead of the 1400px column
// (wide), or collapse the sidebar for as long as it needs the room (focus; it
// comes back as it was). Pages turn these off when they unmount.
const ChromeContext = createContext<{ setMinimal: (v: boolean) => void; setWorkspace: (v: boolean) => void; setWide: (v: boolean) => void; setFocus: (v: boolean) => void }>({
  setMinimal: () => undefined,
  setWorkspace: () => undefined,
  setWide: () => undefined,
  setFocus: () => undefined,
})
export const useChrome = () => useContext(ChromeContext)

// Where a page can put a pane that sits on the canvas beside the content
// panel, the way the sidebar does (the client page's agent chat). The page
// says whether it is open with setPane so narrow screens can give it the room.
const PaneSlotContext = createContext<{ slot: HTMLElement | null; setPane: (v: boolean) => void }>({
  slot: null,
  setPane: () => undefined,
})
export const usePaneSlot = () => useContext(PaneSlotContext)

// A layer over the whole content panel, header included, for a card that
// floats on top of the page (a helper session opened from the agent chat).
const OverlaySlotContext = createContext<HTMLElement | null>(null)
export const useOverlaySlot = () => useContext(OverlaySlotContext)

const COLLAPSED_KEY = "openrecord:sidebar-collapsed"
const WIDTH_KEY = "openrecord:sidebar-width"

// The unchanged default width (w-64), and the resizable bounds. Minimum lets
// the "Chats" list still be readable; maximum keeps the panel agreeable.
const DEFAULT_WIDTH = 256
const MIN_WIDTH = 224
const MAX_WIDTH = 448

const clampWidth = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)))

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

function readWidth(): number {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY)
    const n = raw === null ? NaN : clampWidth(Number(raw))
    if (Number.isFinite(n)) return n
  } catch {
    // Convenience only.
  }
  return DEFAULT_WIDTH
}

// The sidebar's two dropdown menus — the business switcher and the account
// menu — share one look: a wide rounded float. SIDEBAR_MENU_CONTENT sizes and
// shapes the panel; SIDEBAR_MENU_ITEM is handed to each item so hover works
// like the "Start a new chat" rows: bg-accent plus the control shadow.
const SIDEBAR_MENU_CONTENT =
  "w-(--radix-dropdown-menu-trigger-width) min-w-64 rounded-xl p-1.5 shadow-(--float-shadow-strong)"
const SIDEBAR_MENU_ITEM =
  "h-10 rounded-[8px] px-3 text-sm transition-[background-color,box-shadow] hover:bg-accent hover:shadow-(--control-shadow) focus:bg-accent focus:text-sidebar-accent-foreground"

export function AppShell() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [width, setWidth] = useState(readWidth)
  const [dragging, setDragging] = useState(false)
  const [aside, setAside] = useState<HTMLElement | null>(null)
  const dragOrigin = useRef({ x: 0, width: 0 })
  const [mobileOpen, setMobileOpen] = useState(false)
  const [minimal, setMinimal] = useState(false)
  const [workspace, setWorkspace] = useState(false)
  const [wide, setWide] = useState(false)
  const [focus, setFocus] = useState(false)
  // While focused the sidebar is collapsed unless the user opens it again; the
  // saved preference is left untouched.
  const [focusSidebar, setFocusSidebar] = useState(false)
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)
  const [paneSlot, setPaneSlot] = useState<HTMLElement | null>(null)
  const [overlaySlot, setOverlaySlot] = useState<HTMLElement | null>(null)
  const [pane, setPane] = useState(false)
  const paneContext = useMemo(() => ({ slot: paneSlot, setPane }), [paneSlot])
  const location = useLocation()
  const chrome = useMemo(() => ({ setMinimal, setWorkspace, setWide, setFocus }), [])
  const sidebarCollapsed = focus ? !focusSidebar : collapsed
  const toggleSidebar = () => (focus ? setFocusSidebar((v) => !v) : setCollapsed((c) => !c))

  useEffect(() => {
    if (!focus) setFocusSidebar(false)
  }, [focus])

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0")
    } catch {
      // Convenience only.
    }
  }, [collapsed])

  useEffect(() => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      // Convenience only.
    }
  }, [width])

  // Resizing follows the pointer from a setPointerCapture on the handle, so
  // it keeps tracking when the pointer leaves the strip. Double-clicking the
  // handle restores the default width.
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragOrigin.current = { x: e.clientX, width: aside?.offsetWidth ?? width }
    setDragging(true)
  }
  const resize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setWidth(clampWidth(dragOrigin.current.width + e.clientX - dragOrigin.current.x))
  }
  const endResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    setDragging(false)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "b" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        toggleSidebarRef.current()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const toggleSidebarRef = useRef(toggleSidebar)
  toggleSidebarRef.current = toggleSidebar

  useEffect(() => setMobileOpen(false), [location.pathname])

  return (
    <ChatActivityProvider>
    <ChromeContext.Provider value={chrome}>
    <PaneSlotContext.Provider value={paneContext}>
    <OverlaySlotContext.Provider value={overlaySlot}>
    <HeaderSlotContext.Provider value={headerSlot}>
    <CommandPaletteProvider>
    <div className={cn("flex h-svh overflow-hidden bg-sidebar", dragging && "cursor-col-resize select-none")}>
      <aside
        data-collapsed={sidebarCollapsed}
        ref={setAside}
        style={sidebarCollapsed ? undefined : { width }}
        className={cn(
          "relative hidden h-svh shrink-0 flex-col bg-sidebar text-sidebar-foreground md:flex",
          !dragging && "transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
          sidebarCollapsed && "w-[3.25rem]",
        )}
      >
        <SidebarStateContext.Provider value={{ collapsed: sidebarCollapsed, inSheet: false }}>
          <SidebarBody />
        </SidebarStateContext.Provider>
        {/* Drag to resize; double-click restores the default width */}
        {sidebarCollapsed ? null : (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={startResize}
            onPointerMove={resize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onDoubleClick={() => setWidth(DEFAULT_WIDTH)}
            className="absolute inset-y-0 right-0 z-20 -mr-1.5 w-2 cursor-col-resize touch-none"
          />
        )}
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent className="text-sidebar-foreground">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Switch business and move between sections</SheetDescription>
          <SidebarStateContext.Provider value={{ collapsed: false, inSheet: true }}>
            <SidebarBody />
          </SidebarStateContext.Provider>
        </SheetContent>
      </Sheet>

      {/* Content sits on the sidebar-colored canvas as an inset, rounded panel
          that scrolls on its own, so the chrome reads as one layer below it.
          A page's pane (the agent chat) shares the canvas, left of the panel. */}
      <div className="@container flex min-w-0 flex-1">
      <div ref={setPaneSlot} className="contents" />
      <div className={cn("relative flex min-w-0 flex-1 flex-col p-2 md:pl-0", pane && "max-lg:hidden")}>
        <div ref={setOverlaySlot} className="pointer-events-none absolute inset-0 z-30 flex justify-end p-2 md:pl-0 [&>*]:pointer-events-auto" />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-background shadow-(--panel-shadow)">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3 lg:px-5">
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <PanelLeftIcon />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="hidden md:inline-flex"
                onClick={toggleSidebar}
                aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                <PanelLeftIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle sidebar (Ctrl B)</TooltipContent>
          </Tooltip>
          <ViewTabs />
          {minimal ? null : (
            <>
              <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
              <Breadcrumbs />
            </>
          )}
          <div ref={setHeaderSlot} className="ml-auto flex shrink-0 items-center gap-2 [&_[data-slot=button]]:h-8 [&_[data-slot=button]]:px-2.5 [&_[data-slot=button]]:text-xs [&_[data-slot=button]_svg]:size-3.5" />
        </header>
        <main className={cn("relative min-h-0 flex-1", workspace ? "overflow-hidden" : "overflow-y-auto")}>
          <div className={cn("flex w-full flex-col", workspace ? "h-full" : cn("mx-auto min-h-full px-4 pt-6 pb-10 sm:px-6 lg:px-10 lg:pt-8", !wide && "max-w-[1400px]"))}>
            <Outlet />
          </div>
        </main>
        </div>
      </div>
      </div>
    </div>
    </CommandPaletteProvider>
    </HeaderSlotContext.Provider>
    </OverlaySlotContext.Provider>
    </PaneSlotContext.Provider>
    </ChromeContext.Provider>
    </ChatActivityProvider>
  )
}

function useAgentView() {
  const { activeBusiness } = useWorkspace()
  const location = useLocation()
  const { preferences } = usePreferences()
  const base = activeBusiness ? `/businesses/${activeBusiness.id}` : null
  const onOverview = base !== null && location.pathname === `${base}/overview`
  const view = onOverview ? (new URLSearchParams(location.search).get("view") ?? preferences.landingView) : "today"
  return location.pathname === "/agent" || (base !== null && location.pathname === `${base}/agent`) || (onOverview && view === "agent")
}

function SidebarBody() {
  const { collapsed } = useContext(SidebarStateContext)
  const { activeBusiness, overview } = useWorkspace()
  const { open } = useCommandPalette()
  const base = activeBusiness ? `/businesses/${activeBusiness.id}` : null
  const { preferences } = usePreferences()
  const attention = overview && preferences.showIssueCount ? Number(overview.needs_attention) + Number(overview.unreviewed) : 0
  const agent = useAgentView()
  const pathname = useLocation().pathname
  const general = pathname === "/agent"
  const waiting = useWaitingCount(pathname)
  // The chat history shows archived chats instead while this is on.
  const [archived, setArchived] = useState(false)

  return (
    <>
      <div className={cn("flex shrink-0 flex-col gap-2 pt-2", collapsed ? "items-center px-1.5" : "px-2")}>
        {general ? <div className="px-2 py-2 text-sm text-muted-foreground">{collapsed ? <MessagesSquareIcon className="size-4" /> : "General chat"}</div> : <BusinessSwitcher />}
        <div className={cn("flex w-full items-center justify-between", collapsed && "flex-col gap-1")}>
          <SearchButton onOpen={open} />
          <div className={cn("flex items-center gap-0.5", collapsed && "flex-col gap-1")}>
            {agent ? <ArchiveToggle on={archived} onToggle={() => setArchived(v => !v)} /> : null}
            <NewChatDialog />
          </div>
        </div>
      </div>

      <nav className={cn("flex flex-1 flex-col gap-5 overflow-y-auto py-4", collapsed ? "px-1.5" : "px-2")}>
        {agent ? <ChatHistory archived={archived} onLeaveArchive={() => setArchived(false)} /> : <>
          <SidebarGroup label="Workspace">
            <SidebarLink to="/approvals" icon={<CheckCheckIcon />} label="Waiting on you" count={waiting} />
            {base ? <>
              <SidebarLink to={`${base}/results`} icon={<BarChart3Icon />} label="Results" count={attention} />
              <SidebarLink to={`${base}/channels`} icon={<RadioTowerIcon />} label="Channels" />
              <SidebarLink to={`${base}/work`} icon={<BriefcaseIcon />} label="Work" />
            </> : null}
          </SidebarGroup>
          {base ? <EvidenceTools base={base} /> : null}
        </>}
      </nav>

      <div className={cn("shrink-0 py-2", collapsed ? "px-1.5" : "px-2")}>
        <AccountMenu />
      </div>
    </>
  )
}

// Saved agent conversations, newest first. Each opens where it was held: a
// client's record with the agent beside it, or the business's agent view.
const CHATS_SHOWN = 6

// One history row, in both sidebar sizes: the business's mark, the chat's
// title over where it is and when it last moved (or that it is working), and
// the logos of the providers that answered on the right. On hover the row
// makes room beside the logos for its archive button.
export function ChatItem({ c, active }: { c: MergedChat; active: boolean }) {
  // Every provider that answered here, the one answering now last.
  const providers = [...new Set([...(c.providers ?? []), ...(c.providerTag ? [c.providerTag] : [])])]
  const now = c.providerTag ?? providers.at(-1)
  const shown = [...providers.filter(p => p !== now), ...(now ? [now] : [])].slice(-3)
  return (
    <span className="flex w-full min-w-0 items-center gap-2.5">
      <ChatAvatar name={c.businessId === null ? null : c.businessName} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={cn("truncate text-[0.8125rem] leading-5", active && "font-medium")}>{c.title || "New chat"}</span>
        {c.working ? (
          <span role="status" className="flex items-center gap-1.5 text-[0.6875rem] leading-4 text-sky-600 dark:text-sky-300/80">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-sky-500 motion-safe:animate-[status-pulse_2s_infinite] dark:bg-sky-300/80" />
            Working
          </span>
        ) : (
          <span className="truncate text-[0.6875rem] leading-4 text-muted-foreground">
            {c.businessName}, {c.draft ? "not saved" : relativeTime(c.updatedAt)}
          </span>
        )}
      </span>
      {shown.length ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex shrink-0 items-center -space-x-1" role="img" aria-label={`Providers: ${shown.join(", ")}`}>
              {shown.map(p => <span key={p} className="flex size-4 items-center justify-center rounded-full bg-sidebar ring-1 ring-sidebar"><ProviderLogo bare provider={p} className="size-3.5" /></span>)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right">{shown.length > 1 ? `Models used here: ${shown.join(", ")}` : c.working ? "This provider is answering" : "Provider used for the last reply"}</TooltipContent>
        </Tooltip>
      ) : null}
    </span>
  )
}

// The business's mark, or a chat glyph for a general chat, sized for a
// two-line row.
function ChatAvatar({ name }: { name: string | null }) {
  if (name) return <BusinessMark name={name} className="size-7 rounded-lg text-[0.6875rem]" />
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sidebar-accent text-muted-foreground">
      <MessagesSquareIcon className="size-3.5" />
    </span>
  )
}

function ArchiveToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const label = on ? "Back to chats" : "Archived chats"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onToggle} aria-pressed={on} aria-label={label}
          className={cn(on && "bg-sidebar-accent text-sidebar-accent-foreground")}>
          <ArchiveIcon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

// Archives a chat the person is done with, or brings it back, with Undo.
function useArchive() {
  return (c: MergedChat, archived: boolean) => {
    const run = (value: boolean) => Agent.archive(c.id, value).then(notifyAgentChats)
    void run(archived).then(
      () => toast(archived ? "Chat archived" : "Chat restored", { action: { label: "Undo", onClick: () => { void run(!archived).catch(() => toast.error("Couldn't undo. Try again.")) } } }),
      () => toast.error(archived ? "Couldn't archive the chat. Try again." : "Couldn't restore the chat. Try again."),
    )
  }
}

function ChatRow({ c, active, archived }: { c: MergedChat; active: boolean; archived: boolean }) {
  const archive = useArchive()
  const label = archived ? "Restore chat" : "Archive chat"
  return (
    <div className="group/chat relative">
      <Link
        to={chatPath(c)}
        aria-current={active ? "page" : undefined}
        title={`${c.title || "Untitled chat"}, ${c.businessName}`}
        className={cn(
          "flex rounded-lg px-2 py-1.5 outline-none transition-[background-color,padding] duration-200 group-hover/chat:pr-9 group-focus-within/chat:pr-9 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
          active && "bg-sidebar-accent text-sidebar-accent-foreground shadow-(--control-shadow)",
        )}
      >
        <ChatItem c={c} active={active} />
      </Link>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label={label} onClick={() => archive(c, !archived)}
            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-sidebar/80 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring group-hover/chat:opacity-100">
            {archived ? <ArchiveRestoreIcon className="size-3.5" /> : <ArchiveIcon className="size-3.5" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    </div>
  )
}

function ChatHistory({ archived, onLeaveArchive }: { archived: boolean; onLeaveArchive: () => void }) {
  const { collapsed } = useContext(SidebarStateContext)
  // Helper sessions open from the chat that started them, so the history lists only the person's own chats.
  const live = useAgentChats()?.filter(c => !c.parentSessionId) ?? null
  const stored = useArchivedChats(archived)
  const old = useMemo(() => stored?.map((c): MergedChat => ({ ...c, working: false, draft: false })) ?? null, [stored])
  const chats = archived ? old : live
  const location = useLocation()
  const [all, setAll] = useState(false)
  const here = (path: string) => {
    const [pathname, search] = path.split("?")
    return location.pathname === pathname && new URLSearchParams(location.search).get("chat") === new URLSearchParams(search).get("chat")
  }
  const empty = archived ? "No archived chats. Archive a chat you are done with to keep this list short." : "No chats yet. Open a business and ask its agent."

  if (collapsed) {
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger
              aria-label={archived ? "Archived chats" : "Chats"}
              className="flex h-7 w-9 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent [&_svg]:size-3.5"
            >
              {archived ? <ArchiveIcon /> : <MessagesSquareIcon />}
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">{archived ? "Archived chats" : "Chats"}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="right" align="start" className="w-72 rounded-xl p-1.5 shadow-(--float-shadow-strong)">
          <DropdownMenuLabel className="text-[0.625rem] font-medium text-muted-foreground">{archived ? "Archived" : "Chats"}</DropdownMenuLabel>
          {chats?.length ? chats.map((c) => (
            <DropdownMenuItem key={c.id} asChild className="rounded-md">
              <Link to={chatPath(c)} className="flex items-center">
                <ChatItem c={c} active={here(chatPath(c))} />
              </Link>
            </DropdownMenuItem>
          )) : (
            <p className="px-2 py-1.5 text-[0.6875rem] text-muted-foreground">{empty}</p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const shown = all || archived ? chats ?? [] : (chats ?? []).slice(0, CHATS_SHOWN)
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-2 pb-1.5">
        {archived ? (
          <button type="button" onClick={onLeaveArchive} aria-label="Back to chats" className="-ml-1 flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground">
            <ArrowLeftIcon className="size-3.5" />
          </button>
        ) : null}
        <span className="text-sm font-medium text-muted-foreground">{archived ? "Archived" : "Chats"}</span>
        {chats?.length ? <span className="ml-auto text-[0.6875rem] tabular-nums text-muted-foreground">{chats.length}</span> : null}
      </div>
      <div className="flex flex-col gap-0.5">
        {chats === null ? null : chats.length === 0 ? (
          <p className="px-2 py-1 text-[0.8125rem] leading-relaxed text-muted-foreground">{empty}</p>
        ) : (
          <>
            {shown.map((c) => <ChatRow key={c.id} c={c} active={here(chatPath(c))} archived={archived} />)}
            {!archived && chats.length > CHATS_SHOWN ? (
              <button type="button" onClick={() => setAll((v) => !v)} className="rounded-md px-2 py-1 text-left text-[0.8125rem] text-muted-foreground hover:text-foreground">
                {all ? "Show fewer" : `Show all ${chats.length}`}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

// Specialist views stay one click away, folded until needed; they open on
// their own when the current page is one of them.
const EVIDENCE_TOOLS = ["search", "issues", "representations", "truth", "checks", "assay", "facts"]

function EvidenceTools({ base }: { base: string }) {
  const { collapsed } = useContext(SidebarStateContext)
  const location = useLocation()
  const here = EVIDENCE_TOOLS.some(t => location.pathname.startsWith(`${base}/${t}`))
  const [open, setOpen] = useState(here)
  useEffect(() => { if (here) setOpen(true) }, [here])
  const links = (
    <>
      <SidebarLink to={`${base}/search`} icon={<SearchIcon />} label="Website checks" />
      <SidebarLink to={`${base}/issues`} icon={<InboxIcon />} label="AI answer issues" />
      <SidebarLink to={`${base}/representations`} icon={<GlobeIcon />} label="Facts on the web" />
      <SidebarLink to={`${base}/truth`} icon={<BookCheckIcon />} label="Approved facts" />
      <SidebarLink to={`${base}/checks`} icon={<RadarIcon />} label="AI answer checks" />
      <SidebarLink to={`${base}/assay`} icon={<FlaskConicalIcon />} label="Prospect research" />
    </>
  )
  if (collapsed) return open ? <div className="flex flex-col gap-px">{links}</div> : null
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex items-center gap-1 rounded-md px-2 pb-1 text-left text-sm font-medium text-muted-foreground hover:text-foreground">
        Evidence tools
        <ChevronDownIcon className={cn("size-3 transition-transform", open ? "" : "-rotate-90")} />
      </button>
      {open ? <div className="flex flex-col gap-px">{links}</div> : null}
    </div>
  )
}

/** How many decisions wait on the signed-in person; reloads on navigation and after any decision. */
function useWaitingCount(pathname: string) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let live = true
    const load = () => { void Decisions.list().then(r => { if (live) setCount(r.count) }).catch(() => {}) }
    load()
    window.addEventListener(DECISIONS_CHANGED, load)
    window.addEventListener("focus", load)
    return () => { live = false; window.removeEventListener(DECISIONS_CHANGED, load); window.removeEventListener("focus", load) }
  }, [pathname])
  return count
}

function SidebarGroup({ label, children }: { label: string; children: ReactNode }) {
  const { collapsed } = useContext(SidebarStateContext)
  return (
    <div className="flex flex-col">
      {collapsed ? null : <div className="px-2 pb-1 text-sm font-medium text-muted-foreground">{label}</div>}
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  )
}

function SearchButton({ onOpen }: { onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" data-search-trigger onClick={onOpen} aria-label="Find in OpenRecord (F)">
          <SearchIcon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">Find (F)</TooltipContent>
    </Tooltip>
  )
}

// Header tabs share the route-derived view with the sidebar content.
function ViewTabs() {
  const { activeBusiness } = useWorkspace()
  const general = useLocation().pathname === "/agent"
  const nav = useNavigate()
  const agent = useAgentView()
  const view = agent ? "agent" : "today"
  if (!activeBusiness || general) return null
  const base = `/businesses/${activeBusiness.id}`
  const trigger = "h-full min-h-0 self-stretch rounded-[5px] px-2.5 text-xs text-muted-foreground hover:text-foreground data-[state=active]:bg-control data-[state=active]:text-foreground data-[state=active]:shadow-(--control-shadow)"
  return (
    <Tabs
      className="shrink-0"
      value={view}
      onValueChange={(v) => {
        if (v === view) return
        nav(v === "agent" ? `${base}/agent` : `${base}/results`)
      }}
    >
      <TabsList aria-label="Workspace view" className="grid h-7 w-auto grid-cols-2 items-stretch gap-0.5 rounded-[7px] bg-sidebar p-0.5 shadow-[inset_0_0_0_1px_var(--border)]">
        <TabsTrigger value="agent" className={trigger}>Agent</TabsTrigger>
        <TabsTrigger value="today" className={trigger}>Work</TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

function SidebarLink({ to, icon, label, count, end }: { to: string; icon: ReactNode; label: string; count?: number; end?: boolean }) {
  const { collapsed } = useContext(SidebarStateContext)
  // Resolve active state here: a function className would not survive the
  // tooltip's Slot merge in collapsed mode.
  const isActive = useMatch({ path: to, end: end ?? false }) !== null
  const link = (
    <Link
      to={to}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "group/link relative flex h-9 items-center gap-2 rounded-md text-base outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0",
        collapsed ? "w-9 justify-center" : "px-2",
        isActive
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground shadow-(--control-shadow) [&_svg]:text-primary-ink"
          : "[&_svg]:text-muted-foreground",
      )}
    >
      {icon}
      {collapsed ? (
        count ? <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-wrong" aria-label={`${count} open`} /> : null
      ) : (
        <>
          <span className="truncate">{label}</span>
          {count ? (
            <span className="ml-auto rounded-full bg-wrong-soft px-1.5 py-px text-[0.625rem] font-medium tabular-nums text-wrong shadow-(--badge-shadow)">{count}</span>
          ) : null}
        </>
      )}
    </Link>
  )
  if (!collapsed) return link
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{count ? `${label} (${count})` : label}</TooltipContent>
    </Tooltip>
  )
}

function BusinessMark({ name, className }: { name: string | null; className?: string }) {
  const color = name ? markColor(name) : { bg: "bg-primary", text: "text-primary-foreground" }
  return (
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
        color.bg,
        color.text,
        className,
      )}
    >
      {name ? initial(name) : <Building2Icon className="size-4" />}
    </span>
  )
}

function BusinessSwitcher() {
  const { collapsed } = useContext(SidebarStateContext)
  const { businesses, activeBusiness } = useWorkspace()
  const nav = useNavigate()

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-2 rounded-md text-left outline-none transition-[background-color,box-shadow] hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
              collapsed ? "size-9 justify-center" : "min-h-11 w-full px-1.5 py-1",
            )}
            aria-label="Switch business"
          >
            <BusinessMark name={activeBusiness?.name ?? null} className="size-7 text-xs" />
            {collapsed ? null : (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{activeBusiness?.name ?? "OpenRecord"}</span>
                  <span className="block truncate text-[0.625rem] text-muted-foreground">
                    {activeBusiness ? "Business" : "Choose a business"}
                  </span>
                </span>
                <ChevronsUpDownIcon className="size-4 text-muted-foreground" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side={collapsed ? "right" : "bottom"} sideOffset={8} className={SIDEBAR_MENU_CONTENT}>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Businesses</DropdownMenuLabel>
          {businesses.map((b) => (
            <DropdownMenuItem key={b.id} className={SIDEBAR_MENU_ITEM} onSelect={() => nav(`/businesses/${b.id}/agent`)}>
              <BusinessMark name={b.name} className="size-6 text-xs" />
              <span className="truncate">{b.name}</span>
              {activeBusiness?.id === b.id ? <CheckIcon className="ml-auto text-foreground" /> : null}
            </DropdownMenuItem>
          ))}
          {businesses.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem className={SIDEBAR_MENU_ITEM} onSelect={() => nav("/start")}>
            <PlusIcon />
            New business
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

function AccountMenu() {
  const { collapsed } = useContext(SidebarStateContext)
  const { openSettings } = useSettings()
  const nav = useNavigate()
  const email = rememberedEmail()
  const name = email ? email.split("@")[0] ?? email : "Your account"
  const [clients, setClients] = useState<ClientSummary[] | null>(null)
  const [clientsError, setClientsError] = useState(false)
  const loadClients = () => {
    setClientsError(false)
    void Records.list().then(r => setClients(r.clients)).catch(() => { setClients(null); setClientsError(true) })
  }

  const avatar = (size: string) => (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-primary-ink/10 text-xs font-semibold text-primary-ink", size)}>
      {email ? email.charAt(0).toUpperCase() : <UserRoundIcon className="size-4" />}
    </span>
  )

  return (
    <DropdownMenu onOpenChange={open => { if (open) loadClients() }}>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-2 rounded-md text-left text-base outline-none transition-[background-color,box-shadow] hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
            collapsed ? "h-14 w-9 justify-center" : "min-h-16 w-full px-2.5 py-4",
          )}
          aria-label="Account menu"
        >
          {avatar("size-6")}
          {collapsed ? null : (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-base font-medium text-foreground">{name}</span>
              </span>
              <ChevronsUpDownIcon className="size-4 text-muted-foreground" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={collapsed ? "right" : "top"}
        sideOffset={8}
        className={cn("w-(--radix-dropdown-menu-trigger-width) min-w-64", SIDEBAR_MENU_CONTENT)}
      >
        <div className="flex items-center gap-3 px-2.5 py-2.5">
          {avatar("size-9")}
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{name}</div>
            <div className="truncate text-xs text-muted-foreground">{email ?? "Signed in"}</div>
          </div>
        </div>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem className={SIDEBAR_MENU_ITEM} onSelect={() => openSettings("general")}>
          <SettingsIcon />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem className={SIDEBAR_MENU_ITEM} onSelect={() => openSettings("account")}>
          <UserRoundIcon />
          Account
        </DropdownMenuItem>
        <DropdownMenuItem className={SIDEBAR_MENU_ITEM} onSelect={() => openSettings("shortcuts")}>
          <KeyboardIcon />
          Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem className={SIDEBAR_MENU_ITEM} onSelect={() => nav("/businesses")}>
          <Building2Icon />
          All businesses
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Clients</DropdownMenuLabel>
        {clientsError ? <div className="px-3 py-2 text-xs text-destructive">Couldn’t load clients. <button type="button" className="underline" onClick={loadClients}>Try again</button></div>
          : clients === null ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading clients…</p>
          : clients.length === 0 ? <p className="px-3 py-2 text-xs text-muted-foreground">No clients yet.</p>
          : <div className="max-h-48 overflow-y-auto">{clients.map(client => <DropdownMenuItem key={client.businessId} className={SIDEBAR_MENU_ITEM} onSelect={() => nav(`/clients/${encodeURIComponent(client.businessId)}`)}>
            <BusinessMark name={client.name} className="size-6 text-xs" /><span className="truncate">{client.name}</span>
          </DropdownMenuItem>)}</div>}
        <DropdownMenuItem className={SIDEBAR_MENU_ITEM} onSelect={() => nav("/clients")}><BriefcaseIcon />All clients</DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem className={SIDEBAR_MENU_ITEM} onSelect={() => void Auth.signout().finally(() => nav("/signin"))}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Breadcrumbs() {
  const location = useLocation()
  const { activeBusiness } = useWorkspace()
  const parts = location.pathname.split("/").filter(Boolean)
  const crumbs: Array<{ label: string; to?: string }> = []

  if (parts[0] === "businesses" && activeBusiness) {
    const base = `/businesses/${activeBusiness.id}`
    crumbs.push({ label: activeBusiness.name, to: `${base}/agent` })
    const section = parts[2] ?? ""
    const detail = parts[3]
    if (section === "search" && detail === "sites" && parts[5] === "findings" && parts[6]) {
      crumbs.push({ label: sectionTitles["search"] ?? "Website checks", to: `${base}/search` })
      crumbs.push({ label: "Finding" })
    } else if (section === "search" && detail) {
      crumbs.push({ label: sectionTitles["search"] ?? "Website checks", to: `${base}/search` })
      crumbs.push({ label: detail === "sites" ? "Site" : (sectionTitles[detail] ?? "Website checks") })
    } else if ((section === "issues" || section === "representations") && detail) {
      const parent = sectionTitles[section] ?? section
      const child = section === "issues" ? "Issue" : detail === "discovery" ? "Discovery" : "Fact on the web"
      crumbs.push({ label: parent, to: `${base}/${section}` })
      crumbs.push({ label: child })
    } else {
      crumbs.push({ label: sectionTitles[section] ?? "Agent" })
    }
  } else if (parts[0] === "observations") {
    if (activeBusiness) {
      crumbs.push({ label: activeBusiness.name, to: `/businesses/${activeBusiness.id}/agent` })
      crumbs.push(
        new URLSearchParams(location.search).has("claim")
          ? { label: "Issues", to: `/businesses/${activeBusiness.id}/issues` }
          : { label: "Checks", to: `/businesses/${activeBusiness.id}/checks` },
      )
    }
    crumbs.push({ label: "AI answer" })
  } else if (parts[0] === "clients") {
    crumbs.push({ label: "Clients", ...(parts[1] ? { to: "/clients" } : {}) })
    if (parts[1] && activeBusiness?.id === parts[1]) crumbs.push({ label: activeBusiness.name, to: `/businesses/${activeBusiness.id}/agent` })
    if (parts[1]) crumbs.push({ label: parts[2] === "growth" ? "Growth workspace" : parts[2] === "growth-measurement" ? "Measurement imports" : parts[2] === "discovery" ? "AI Discovery" : "Client record" })
  } else if (parts[0] === "agent") {
    crumbs.push({ label: "General chat" })
  } else if (parts[0] === "approvals") {
    crumbs.push({ label: "Waiting on you" })
  } else if (parts[0] === "start") {
    crumbs.push({ label: "Set up a business" })
  } else if (parts[0] === "products" && parts[1] === "new") {
    crumbs.push({ label: "Clients", to: "/clients" }, { label: "Add a product" })
  } else {
    crumbs.push({ label: "All businesses" })
  }

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-xs">
        {crumbs.map((c, i) => (
          <li key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
            {i > 0 ? <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" /> : null}
            {c.to ? (
              <Link to={c.to} className="truncate text-muted-foreground transition-colors hover:text-foreground">
                {c.label}
              </Link>
            ) : (
              <span className="truncate font-medium text-foreground">{c.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
