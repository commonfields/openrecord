import { useState } from "react"
import { useNavigate } from "react-router"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PageHeader, Panel } from "@/components/page"
import { useWorkspace } from "@/lib/workspace"
import { errorMessage } from "@/lib/format"
import { Records, type Engagement } from "@/lib/record"

export function NewProductPage() {
  const navigate = useNavigate()
  const { reloadBusinesses, setActiveBusinessId } = useWorkspace()
  const [engagement, setEngagement] = useState<Engagement>("DOGFOOD")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return <div className="max-w-2xl space-y-4 pb-4">
    <PageHeader title="Add a product" back={{ to: "/clients", label: "Clients" }} description="Add the product and its website, then work with its agent." />
    <Panel><form className="grid gap-4 p-5" onSubmit={async e => {
      e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError(null)
      try {
        const { client } = await Records.create({ name: String(form.get("name") ?? "").trim(), websiteUrl: String(form.get("websiteUrl") ?? "").trim(), engagement })
        await reloadBusinesses()
        setActiveBusinessId(client.businessId)
        navigate(`/businesses/${client.businessId}/agent`)
      } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
    }}>
      <div className="grid gap-2"><Label htmlFor="product-name">Product name</Label><Input id="product-name" name="name" maxLength={200} required autoFocus /></div>
      <div className="grid gap-2"><Label htmlFor="product-url">Website</Label><Input id="product-url" name="websiteUrl" type="url" placeholder="https://example.com" maxLength={2000} required /></div>
      <div className="grid gap-2"><Label htmlFor="product-basis">Ownership</Label><Select value={engagement} onValueChange={value => setEngagement(value as Engagement)}><SelectTrigger id="product-basis" className="w-full"><SelectValue /></SelectTrigger><SelectContent>
        <SelectItem value="DOGFOOD">Our product</SelectItem><SelectItem value="CLIENT">Client product</SelectItem>
      </SelectContent></Select></div>
      <p className="text-xs text-muted-foreground">Adding a website does not grant publishing or account access.</p>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <Button className="justify-self-start" disabled={busy}>{busy ? "Adding product…" : "Continue to agent"}</Button>
    </form></Panel>
  </div>
}
