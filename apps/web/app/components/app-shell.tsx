import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Link, Outlet, useLocation, useMatch, useNavigate } from "react-router"
import {
  BookCheckIcon,
  Building2Icon,
  FileCheck2Icon,
  FlaskConicalIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  GlobeIcon,
  InboxIcon,
  KeyboardIcon,
  LayoutGridIcon,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CreateBusinessDialog } from "@/components/create-business-dialog"
import { useSettings } from "@/components/settings-dialog"
import { rememberedEmail, usePreferences } from "@/lib/preferences"
import { Auth } from "@/lib/api"
import { initial, markColor, relativeTime } from "@/lib/format"
import { chatPath, useAgentChats } from "@/lib/agent-chats"
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
  )
}

function SidebarBody() {
  const { collapsed } = useContext(SidebarStateContext)
  const { activeBusiness, overview } = useWorkspace()
  const { open } = useCommandPalette()
  const base = activeBusiness ? `/businesses/${activeBusiness.id}` : null
  const { preferences } = usePreferences()
  const attention = overview && preferences.showIssueCount ? Number(overview.needs_attention) + Number(overview.unreviewed) : 0

  return (
    <>
      <div className={cn("flex shrink-0 flex-col gap-2 pt-2", collapsed ? "items-center px-1.5" : "px-2")}>
        <BusinessSwitcher />
        <SearchBar collapsed={collapsed} onOpen={open} />
      </div>

      <nav className={cn("flex flex-1 flex-col gap-5 overflow-y-auto py-4", collapsed ? "px-1.5" : "px-2")}>
        {base ? (
          <SidebarGroup label="Workspace">
            <SidebarLink to={`${base}/overview`} icon={<LayoutGridIcon />} label="Overview" />
            <SidebarLink to={`${base}/assay`} icon={<FlaskConicalIcon />} label="Prospect assay" />
            <SidebarLink to={`${base}/search`} icon={<SearchIcon />} label="Search" />
            <SidebarLink to={`${base}/issues`} icon={<InboxIcon />} label="Issues" count={attention} />
            <SidebarLink to={`${base}/representations`} icon={<GlobeIcon />} label="Representations" />
            <SidebarLink to={`${base}/truth`} icon={<BookCheckIcon />} label="Truth" />
            <SidebarLink to={`${base}/checks`} icon={<RadarIcon />} label="Checks" />
          </SidebarGroup>
        ) : null}
        <SidebarGroup label="Agency">
          <SidebarLink to="/clients" icon={<FileCheck2Icon />} label="Clients" />
          <SidebarLink to="/businesses" end icon={<Building2Icon />} label="All businesses" />
        </SidebarGroup>
        <ChatHistory />
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

function ChatHistory() {
  const { collapsed } = useContext(SidebarStateContext)
  const chats = useAgentChats()
  const location = useLocation()
  const [all, setAll] = useState(false)
  const here = (path: string) => {
    const [pathname] = path.split("?")
    return location.pathname === pathname && (pathname!.startsWith("/clients/") || new URLSearchParams(location.search).get("view") === "agent")
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
            <DropdownMenuItem key={c.businessId} asChild className="rounded-md">
              <Link to={chatPath(c)} className="flex flex-col items-start gap-0">
                <span className="w-full truncate text-xs">{c.title || "Untitled chat"}</span>
                <span className="w-full truncate text-[0.625rem] text-muted-foreground">{c.businessName} · {relativeTime(c.updatedAt)}</span>
              </Link>
            </DropdownMenuItem>
          )) : (
            <p className="px-2 py-1.5 text-[0.6875rem] text-muted-foreground">No chats yet. Ask the agent on a client or overview page.</p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const shown = all ? chats ?? [] : (chats ?? []).slice(0, CHATS_SHOWN)
  return (
    <SidebarGroup label="Chats">
      {chats === null ? null : chats.length === 0 ? (
        <p className="px-2 py-1 text-[0.6875rem] leading-relaxed text-muted-foreground">No chats yet. Ask the agent on a client or overview page.</p>
      ) : (
        <>
          {shown.map((c) => {
            const to = chatPath(c)
            const active = here(to)
            return (
              <Link
                key={c.businessId}
                to={to}
                aria-current={active ? "page" : undefined}
                title={`${c.title} · ${c.businessName}`}
                className={cn(
                  "flex flex-col rounded-md px-2 py-1 outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  active && "bg-sidebar-accent text-sidebar-accent-foreground",
                )}
              >
                <span className={cn("truncate text-xs", active && "font-medium")}>{c.title || "Untitled chat"}</span>
                <span className="truncate text-[0.625rem] text-muted-foreground">{c.businessName} · {relativeTime(c.updatedAt)}</span>
              </Link>
            )
          })}
          {chats.length > CHATS_SHOWN ? (
            <button type="button" onClick={() => setAll((v) => !v)} className="rounded-md px-2 py-1 text-left text-[0.6875rem] text-muted-foreground hover:text-foreground">
              {all ? "Show fewer" : `Show all ${chats.length}`}
            </button>
          ) : null}
        </>
      )}
    </SidebarGroup>
  )
}

function SidebarGroup({ label, children }: { label: string; children: ReactNode }) {
  const { collapsed } = useContext(SidebarStateContext)
  return (
    <div className="flex flex-col">
      {collapsed ? null : <div className="px-2 pb-1 text-[0.625rem] font-medium text-muted-foreground">{label}</div>}
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  )
}

// The search bar: an input-shaped trigger that opens the search menu (the
// command palette). Its design is self-contained — where it sits comes in as
// `collapsed` and how the menu opens as `onOpen`, so it is decoupled from both
// the sidebar and the menu itself.
function SearchBar({ collapsed, onOpen }: { collapsed: boolean; onOpen: () => void }) {
  const button = (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Find in OpenRecord (F)"
      className={cn(
        "flex items-center gap-2 rounded-md border bg-card text-xs text-muted-foreground shadow-(--control-shadow) outline-none transition-colors hover:text-foreground",
        collapsed ? "size-9 justify-center" : "h-7 w-full px-2",
      )}
    >
      <SearchIcon className="size-3.5 shrink-0" />
      {collapsed ? null : (
        <>
          <span className="flex-1 text-left">Find…</span>
          <kbd className="shrink-0 whitespace-nowrap font-sans text-[0.5625rem] leading-none text-muted-foreground">F</kbd>
        </>
      )}
    </button>
  )
  if (!collapsed) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">Find (F)</TooltipContent>
    </Tooltip>
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
        "group/link relative flex h-7 items-center gap-2 rounded-md text-xs outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:shrink-0",
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
  const [createOpen, setCreateOpen] = useState(false)
  const nav = useNavigate()

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-2 rounded-md text-left outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:bg-sidebar-accent",
              collapsed ? "size-9 justify-center" : "h-9 w-full px-1.5",
            )}
            aria-label="Switch business"
          >
            <BusinessMark name={activeBusiness?.name ?? null} />
            {collapsed ? null : (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-foreground">{activeBusiness?.name ?? "OpenRecord"}</span>
                  <span className="block truncate text-[0.6875rem] text-muted-foreground">
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
            <DropdownMenuItem key={b.id} onSelect={() => nav(`/businesses/${b.id}/overview`)}>
              <BusinessMark name={b.name} className="size-6 text-xs" />
              <span className="truncate">{b.name}</span>
              {activeBusiness?.id === b.id ? <CheckIcon className="ml-auto text-foreground" /> : null}
            </DropdownMenuItem>
          ))}
          {businesses.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
            <PlusIcon />
            New business
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateBusinessDialog open={createOpen} onOpenChange={setCreateOpen} />
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
            "flex items-center gap-2 rounded-md text-left text-xs outline-none transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:bg-sidebar-accent",
            collapsed ? "size-9 justify-center" : "h-9 w-full px-1.5",
          )}
          aria-label="Account menu"
        >
          {avatar("size-6")}
          {collapsed ? null : (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-foreground">{name}</span>
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
    crumbs.push({ label: activeBusiness.name, to: `${base}/overview` })
    const section = parts[2] ?? ""
    const detail = parts[3]
    if (section === "search" && detail === "sites" && parts[5] === "findings" && parts[6]) {
      crumbs.push({ label: "Search", to: `${base}/search` })
      crumbs.push({ label: "Finding" })
    } else if (section === "search" && detail) {
      crumbs.push({ label: "Search", to: `${base}/search` })
      crumbs.push({ label: detail === "sites" ? "Site" : (sectionTitles[detail] ?? "Search") })
    } else if ((section === "issues" || section === "representations") && detail) {
      const parent = section === "issues" ? "Issues" : "Representations"
      const child = section === "issues" ? "Issue" : detail === "discovery" ? "Discovery" : "Representation"
      crumbs.push({ label: parent, to: `${base}/${section}` })
      crumbs.push({ label: child })
    } else {
      crumbs.push({ label: sectionTitles[section] ?? "Overview" })
    }
  } else if (parts[0] === "observations") {
    if (activeBusiness) {
      crumbs.push({ label: activeBusiness.name, to: `/businesses/${activeBusiness.id}/overview` })
      crumbs.push(
        new URLSearchParams(location.search).has("claim")
          ? { label: "Issues", to: `/businesses/${activeBusiness.id}/issues` }
          : { label: "Checks", to: `/businesses/${activeBusiness.id}/checks` },
      )
    }
    crumbs.push({ label: "AI answer" })
  } else if (parts[0] === "clients") {
    crumbs.push({ label: "Clients", ...(parts[1] ? { to: "/clients" } : {}) })
    if (parts[1]) crumbs.push({ label: parts[2] === "growth" ? "Growth workspace" : parts[2] === "growth-measurement" ? "Measurement imports" : parts[2] === "discovery" ? "AI Discovery" : "Client record" })
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
