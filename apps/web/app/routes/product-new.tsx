import { useState } from "react"
import { useNavigate } from "react-router"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PageHeader, Panel } from "@/components/page"
import { GrowthProfileFields } from "@/components/growth-profile-fields"
import { useWorkspace } from "@/lib/workspace"
import { Growth, growthError, growthPath, profileFromForm } from "@/lib/growth"

export function NewProductPage() {
  const navigate = useNavigate()
  const { reloadBusinesses, setActiveBusinessId } = useWorkspace()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestKey] = useState(() => crypto.randomUUID())
  return <div className="max-w-2xl space-y-4 pb-4">
    <PageHeader title="Add a product" back={{ to: "/clients", label: "Products and clients" }} description="Define the product you operate and the outcome you want to measure." />
    <Panel><form className="grid gap-4 p-5" onSubmit={async e => {
      e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError(null)
      try {
        const engagement = form.get("engagement")
        if (engagement !== "DOGFOOD" && engagement !== "CLIENT") throw new Error("Choose an ownership basis.")
        const { profile } = await Growth.register({ name: String(form.get("name") ?? "").trim(), websiteUrl: String(form.get("websiteUrl") ?? "").trim(), engagement,
          ...profileFromForm(form), idempotencyKey: requestKey })
        await reloadBusinesses()
        setActiveBusinessId(profile.businessId)
        navigate(growthPath(profile.businessId))
      } catch (err) { setError(growthError(err)) } finally { setBusy(false) }
    }}>
      <div className="grid gap-2"><Label htmlFor="product-name">Product name</Label><Input id="product-name" name="name" maxLength={200} required autoFocus /></div>
      <div className="grid gap-2"><Label htmlFor="product-url">Website</Label><Input id="product-url" name="websiteUrl" type="url" placeholder="https://example.com" maxLength={2000} required /></div>
      <div className="grid gap-2"><Label htmlFor="product-basis">Ownership basis</Label><Select name="engagement" defaultValue="DOGFOOD"><SelectTrigger id="product-basis" className="w-full"><SelectValue /></SelectTrigger><SelectContent>
        <SelectItem value="DOGFOOD">Owned product (Dogfood)</SelectItem><SelectItem value="CLIENT">Authorized client</SelectItem>
      </SelectContent></Select></div>
      <p className="text-xs text-muted-foreground">A website address records context. It does not grant publishing rights or repository access.</p>
      <GrowthProfileFields />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <Button className="justify-self-start" disabled={busy}>{busy ? "Saving product…" : "Add product"}</Button>
    </form></Panel>
  </div>
}
