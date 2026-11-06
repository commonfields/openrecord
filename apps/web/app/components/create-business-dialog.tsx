import { useNavigate } from "react-router"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { SetupStartForm } from "@/components/setup-flow"
import { useWorkspace } from "@/lib/workspace"

export function CreateBusinessDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { reloadBusinesses, setActiveBusinessId } = useWorkspace()
  const navigate = useNavigate()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 bg-transparent p-0 shadow-none [&>button]:sr-only">
        <DialogTitle className="sr-only">Add a business</DialogTitle>
        <DialogDescription className="sr-only">Enter a website and optionally a goal to start setup.</DialogDescription>
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
