import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link, Outlet, useLocation, useMatch, useNavigate } from "react-router"
import {
  BarChart3Icon,
  BookCheckIcon,
  BriefcaseIcon,
  ChevronDownIcon,
  RadioTowerIcon,
  Building2Icon,
  FlaskConicalIcon,
  CheckIcon,
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
import { Auth } from "@/lib/api"
import { initial, markColor, relativeTime } from "@/lib/format"
import { ChatActivityProvider, chatPath, useAgentChats, type MergedChat } from "@/lib/agent-chats"
import { ProviderLogo } from "@/components/provider-logo"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"

type SidebarState = { collapsed: boolean; inSheet: boolean }
const SidebarStateContext = createContext<SidebarState>({ collapsed: false, inSheet: false })

// Lets page content (e.g. an agent chat) adjust the shell: hide the header's
// breadcrumbs, take the full height to lay out its own scrolling panes
// (workspace), or collapse the sidebar for as long as it needs the room
// (focus; it comes back as it was). Pages turn these off when they unmount.
const ChromeContext = createContext<{ setMinimal: (v: boolean) => void; setWorkspace: (v: boolean) => void; setFocus: (v: boolean) => void }>({
  setMinimal: () => undefined,
  setWorkspace: () => undefined,
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

const COLLAPSED_KEY = "openrecord:sidebar-collapsed"

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [minimal, setMinimal] = useState(false)
  const [workspace, setWorkspace] = useState(false)
  const [focus, setFocus] = useState(false)
  // While focused the sidebar is collapsed unless the user opens it again; the
  // saved preference is left untouched.
  const [focusSidebar, setFocusSidebar] = useState(false)
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null)
  const [paneSlot, setPaneSlot] = useState<HTMLElement | null>(null)
  const [pane, setPane] = useState(false)
  const paneContext = useMemo(() => ({ slot: paneSlot, setPane }), [paneSlot])
  const location = useLocation()
  const chrome = useMemo(() => ({ setMinimal, setWorkspace, setFocus }), [])
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
    <HeaderSlotContext.Provider value={headerSlot}>
    <CommandPaletteProvider>
    <div className="flex h-svh overflow-hidden bg-sidebar">
      <aside
        data-collapsed={sidebarCollapsed}
        className={cn(
          "hidden h-svh shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] md:flex",
          sidebarCollapsed ? "w-[3.25rem]" : "w-64",
        )}
      >
        <SidebarStateContext.Provider value={{ collapsed: sidebarCollapsed, inSheet: false }}>
          <SidebarBody />
        </SidebarStateContext.Provider>
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
      <div className={cn("flex min-w-0 flex-1 flex-col p-2 md:pl-0", pane && "max-lg:hidden")}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-background shadow-(--panel-shadow)">
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
          <div className={cn("flex w-full flex-col", workspace ? "h-full" : "mx-auto min-h-full max-w-[1400px] px-4 pt-6 pb-10 sm:px-6 lg:px-10 lg:pt-8")}>
            <Outlet />
          </div>
        </main>
        </div>
      </div>
      </div>
    </div>
    </CommandPaletteProvider>
    </HeaderSlotContext.Provider>
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
  const general = useLocation().pathname === "/agent"

  return (
    <>
      <div className={cn("flex shrink-0 flex-col gap-2 pt-2", collapsed ? "items-center px-1.5" : "px-2")}>
        {general ? <div className="px-2 py-2 text-sm text-muted-foreground">{collapsed ? <MessagesSquareIcon className="size-4" /> : "General chat"}</div> : <BusinessSwitcher />}
        <div className={cn("flex w-full items-center justify-between", collapsed && "flex-col gap-1")}>
          <SearchButton onOpen={open} />
          <NewChatDialog />
        </div>
      </div>

      <nav className={cn("flex flex-1 flex-col gap-5 overflow-y-auto py-4", collapsed ? "px-1.5" : "px-2")}>
        {agent ? <ChatHistory /> : <>
          {base ? (
            <>
              <SidebarGroup label="Workspace">
                <SidebarLink to={`${base}/results`} icon={<BarChart3Icon />} label="Results" count={attention} />
                <SidebarLink to={`${base}/channels`} icon={<RadioTowerIcon />} label="Channels" />
                <SidebarLink to={`${base}/work`} icon={<BriefcaseIcon />} label="Work" />
              </SidebarGroup>
              <EvidenceTools base={base} />
            </>
          ) : null}
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

// One history row, in both sidebar sizes: context line first (the client or
// business, plus the working provider's logo on the right), then the chat's
// title, then its status: working, unsent, or when it last moved.
function ChatItem({ c, active }: { c: MergedChat; active: boolean }) {
  return (
    <>
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate text-[0.625rem] text-muted-foreground">{c.businessName}</span>
        {c.working && c.providerTag ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="ml-auto shrink-0">
                <ProviderLogo bare provider={c.providerTag} className="size-3.5" aria-label="Working provider" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="left">This provider is answering</TooltipContent>
          </Tooltip>
        ) : null}
      </span>
      <span className={cn("w-full truncate text-sm", active && "font-medium")}>{c.title || "Untitled chat"}</span>
      {c.working ? <span role="status" className="thinking text-xs">Working…</span>
        : c.draft ? <span className="w-full truncate text-xs text-muted-foreground">Not saved</span>
        : <span className="w-full truncate text-xs text-muted-foreground">{relativeTime(c.updatedAt)}</span>}
    </>
  )
}

function ChatHistory() {
  const { collapsed } = useContext(SidebarStateContext)
  const chats = useAgentChats()
  const location = useLocation()
  const [all, setAll] = useState(false)
  const here = (path: string) => {
    const [pathname, search] = path.split("?")
    return location.pathname === pathname && new URLSearchParams(location.search).get("chat") === new URLSearchParams(search).get("chat")
  }

  if (collapsed) {
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger
              aria-label="Chats"
              className="flex h-7 w-9 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground data-[state=open]:bg-sidebar-accent [&_svg]:size-3.5"
            >
              <MessagesSquareIcon />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="right">Chats</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="right" align="start" className="w-72 rounded-xl p-1.5 shadow-(--float-shadow-strong)">
          <DropdownMenuLabel className="text-[0.625rem] font-medium text-muted-foreground">Chats</DropdownMenuLabel>
          {chats?.length ? chats.map((c) => (
            <DropdownMenuItem key={c.id} asChild className="rounded-md">
              <Link to={chatPath(c)} className="flex flex-col items-start gap-0">
                <ChatItem c={c} active={here(chatPath(c))} />
              </Link>
            </DropdownMenuItem>
          )) : (
            <p className="px-2 py-1.5 text-[0.6875rem] text-muted-foreground">No chats yet. Open a business and ask its agent.</p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const shown = all ? chats ?? [] : (chats ?? []).slice(0, CHATS_SHOWN)
  return (
    <SidebarGroup label="Chats">
      {chats === null ? null : chats.length === 0 ? (
        <p className="px-2 py-1 text-sm leading-relaxed text-muted-foreground">No chats yet. Open a business and ask its agent.</p>
      ) : (
        <>
          {shown.map((c) => {
            const to = chatPath(c)
            const active = here(to)
            return (
              <Link
                key={c.id}
                to={to}
                aria-current={active ? "page" : undefined}
                title={`${c.title || "Untitled chat"} · ${c.businessName}`}
                className={cn(
                  "flex flex-col rounded-md px-2 py-1 outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  active && "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
              >
                <ChatItem c={c} active={active} />
              </Link>
            )
          })}
          {chats.length > CHATS_SHOWN ? (
            <button type="button" onClick={() => setAll((v) => !v)} className="rounded-md px-2 py-1 text-left text-sm text-muted-foreground hover:text-foreground">
              {all ? "Show fewer" : `Show all ${chats.length}`}
            </button>
          ) : null}
        </>
      )}
    </SidebarGroup>
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
  const trigger = "h-full min-h-0 self-stretch rounded-[3px] px-1 text-[0.6875rem] text-sidebar-foreground/90 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm"
  return (
    <Tabs
      className="shrink-0"
      value={view}
      onValueChange={(v) => {
        if (v === view) return
        nav(v === "agent" ? `${base}/agent` : `${base}/results`)
      }}
    >
      <TabsList aria-label="Workspace view" className="grid h-6 w-auto grid-cols-2 items-stretch rounded-md border border-sidebar-border bg-sidebar-accent/60 p-0.5">
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
        "group/link relative flex h-9 items-center gap-2 rounded-md text-base outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
        collapsed ? "w-9 justify-center" : "px-2",
        isActive
          ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground [&_svg]:text-primary-ink"
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
              "flex items-center gap-2 rounded-md text-left outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:bg-sidebar-accent",
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
        <DropdownMenuContent align="start" side={collapsed ? "right" : "bottom"} className="w-60">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Businesses</DropdownMenuLabel>
          {businesses.map((b) => (
            <DropdownMenuItem key={b.id} onSelect={() => nav(`/businesses/${b.id}/agent`)}>
              <BusinessMark name={b.name} className="size-6 text-xs" />
              <span className="truncate">{b.name}</span>
              {activeBusiness?.id === b.id ? <CheckIcon className="ml-auto text-foreground" /> : null}
            </DropdownMenuItem>
          ))}
          {businesses.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => nav("/start")}>
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

  const avatar = (size: string) => (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-primary-ink/10 text-xs font-semibold text-primary-ink", size)}>
      {email ? email.charAt(0).toUpperCase() : <UserRoundIcon className="size-4" />}
    </span>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-2 rounded-md text-left text-base outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:bg-sidebar-accent",
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
        className="w-(--radix-dropdown-menu-trigger-width) min-w-64 rounded-xl p-1.5 shadow-(--float-shadow-strong) [&_[data-slot=dropdown-menu-item]]:h-9 [&_[data-slot=dropdown-menu-item]]:rounded-md [&_[data-slot=dropdown-menu-item]]:px-2.5 [&_[data-slot=dropdown-menu-item]]:focus:bg-sidebar-accent/70 [&_[data-slot=dropdown-menu-item]]:focus:text-sidebar-accent-foreground"
      >
        <div className="flex items-center gap-3 px-2.5 py-2.5">
          {avatar("size-9")}
          <div className="min-w-0">
            <div className="truncate text-xs font-medium">{name}</div>
            <div className="truncate text-xs text-muted-foreground">{email ?? "Signed in"}</div>
          </div>
        </div>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem onSelect={() => openSettings("general")}>
          <SettingsIcon />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openSettings("account")}>
          <UserRoundIcon />
          Account
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openSettings("shortcuts")}>
          <KeyboardIcon />
          Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem onSelect={() => nav("/businesses")}>
          <Building2Icon />
          All businesses
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem onSelect={() => void Auth.signout().finally(() => nav("/signin"))}>
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
