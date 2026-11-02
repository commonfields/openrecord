import { useNavigate } from "react-router"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { SetupStartForm } from "@/components/setup-flow"
import { useWorkspace } from "@/lib/workspace"

export function CreateBusinessDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { reloadBusinesses, setActiveBusinessId } = useWorkspace()
  const navigate = useNavigate()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a business</DialogTitle>
          <DialogDescription>Tell your agent the website and what you want to achieve. It does the rest.</DialogDescription>
        </DialogHeader>
        <SetupStartForm
          autoFocus
          onStarted={async setup => {
            await reloadBusinesses()
            setActiveBusinessId(setup.businessId)
            onOpenChange(false)
            navigate(`/businesses/${setup.businessId}/agent`)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
