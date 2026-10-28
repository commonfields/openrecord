import { useEffect, useRef, useState } from "react"
import { Popover } from "radix-ui"
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { modelBrand, ProviderLogo } from "@/components/provider-logo"
import { HARNESS_NAMES, type HarnessDriver, type ModelOption } from "@/lib/harness"
import { cn } from "@/lib/utils"

type ProviderTab = "all" | "hosted" | HarnessDriver

export const modelProvider = (option: ModelOption): Exclude<ProviderTab, "all"> => option.kind === "hosted" ? "hosted" : option.instance.driver
export const modelName = (option: ModelOption): string => option.kind === "hosted" ? option.model : option.model.name

export function filterModels(options: readonly ModelOption[], provider: ProviderTab, query: string): readonly ModelOption[] {
  const search = query.trim().toLocaleLowerCase()
  return options.filter(option => (provider === "all" || modelProvider(option) === provider) &&
    `${modelName(option)} ${option.kind === "instance" ? option.model.id : option.model}`.toLocaleLowerCase().includes(search))
}

function optionLogo(option: ModelOption) {
  return option.kind === "hosted" ? modelBrand(option.model, option.provider) : modelBrand(option.model.id, option.instance.driver)
}

export function AgentModelPicker({ options, value, label, checking, unavailable, locked, onChoose, onManage }: {
  options: readonly ModelOption[]; value: string | undefined; label: string; checking: boolean; unavailable: boolean; locked: boolean
  onChoose: (option: ModelOption) => void; onManage: () => void
}) {
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState<ProviderTab>("all")
  const [query, setQuery] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selected = options.find(option => option.value === value)
  const providers = [...new Set(options.map(modelProvider))]
  const activeProvider = provider === "all" || providers.includes(provider) ? provider : "all"
  const visible = filterModels(options, activeProvider, query)
  const tabs: readonly ProviderTab[] = ["all", ...providers]
  useEffect(() => { if (locked) setOpen(false) }, [locked])

  return (
    <Popover.Root open={open && !locked} onOpenChange={next => {
      if (next && locked) return
      if (next) { setProvider(selected ? modelProvider(selected) : "all"); setQuery("") }
      setOpen(next)
    }}>
      <Popover.Trigger asChild>
        <button type="button" aria-label="Agent model" disabled={locked} className="inline-flex max-w-56 items-center gap-1 border-0 bg-transparent p-0 text-xs text-muted-foreground shadow-none outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          {selected ? <ProviderLogo bare provider={optionLogo(selected)} className="size-4" /> : null}
          <span className="truncate">{selected ? modelName(selected) : label}</span><ChevronDownIcon className="size-3.5 shrink-0" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="end" sideOffset={8} aria-label="Choose an agent model" className="z-50 max-h-(--radix-popover-content-available-height) w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-xl outline-none dark:border-[#414141] dark:bg-[#303030]" onOpenAutoFocus={event => { event.preventDefault(); searchRef.current?.focus() }}>
          <Tabs value={activeProvider} onValueChange={next => { const tab = tabs.find(tab => tab === next); if (tab) setProvider(tab) }} className="gap-2">
            <TabsList aria-label="Model providers" className="h-9 w-full justify-start rounded-md bg-muted p-0.5">
              {tabs.map(tab => {
                const hosted = options.find(option => option.kind === "hosted")
                const name = tab === "all" ? "All providers" : tab === "hosted" ? "OpenRecord hosted" : HARNESS_NAMES[tab]
                const logo = tab === "hosted" ? (hosted?.kind === "hosted" ? hosted.provider : "gemini") : tab === "claude" ? "claude-code" : tab
                return <TabsTrigger key={tab} value={tab} aria-label={name} title={name} className="h-8 min-w-10 flex-1 rounded-sm px-2 data-[state=active]:bg-background data-[state=active]:shadow-sm">{tab === "all" ? "All" : <><ProviderLogo bare provider={logo} className="size-5" /><span className="sr-only">{name}</span></>}</TabsTrigger>
              })}
            </TabsList>
            <label className="flex items-center gap-2 rounded-md border border-input px-2.5 py-2">
              <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input ref={searchRef} type="search" aria-label="Search models" placeholder="Search models…" value={query} onChange={event => setQuery(event.currentTarget.value)} onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); listRef.current?.querySelector<HTMLButtonElement>('[role="option"]')?.focus() } }} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
            </label>
            <TabsContent value={activeProvider} className="min-h-0">
              <div ref={listRef} role="listbox" aria-label="Models" className="max-h-64 overflow-y-auto" onKeyDown={event => {
                const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')]
                const index = buttons.findIndex(button => button === document.activeElement)
                const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null
                if (next !== null) { event.preventDefault(); buttons[next]?.focus() }
              }}>
                {visible.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} disabled={locked} onClick={() => { if (!locked) { onChoose(option); setOpen(false) } }} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent", option.value === value && "bg-accent/50")}>
                  <ProviderLogo bare provider={optionLogo(option)} className="size-4" />
                  <span className="min-w-0 flex-1"><span className="block truncate">{modelName(option)}</span>{option.kind === "instance" ? <span className="block truncate text-xs text-muted-foreground">{option.instance.name}</span> : null}</span>
                  {option.value === value ? <CheckIcon className="size-4 shrink-0 text-secondary" aria-hidden /> : null}
                </button>)}
              </div>
              {checking ? <p role="status" className="px-2 py-3 text-xs text-muted-foreground">Checking providers…</p> : visible.length === 0 ? <p role="status" className="px-2 py-3 text-xs text-muted-foreground">{options.length ? "No models match your search." : "No agent model is ready. Connect a provider in Settings."}</p> : null}
            </TabsContent>
          </Tabs>
          {unavailable ? <p role="note" className="px-2 py-2 text-xs text-wrong">The model you used is unavailable now. Pick another one.</p> : null}
          <button type="button" onClick={() => { setOpen(false); onManage() }} className="mt-2 w-full border-t border-border px-2 pt-2 pb-1 text-left text-sm outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring">Manage providers…</button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
