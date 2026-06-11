import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sparkles } from "lucide-react";
import type { ReleaseEntry } from "../../../shared/rpc/whats-new";

interface WhatsNewDialogProps {
  entries: ReleaseEntry[];
  onClose: () => void;
}

export function WhatsNewDialog({ entries, onClose }: WhatsNewDialogProps) {
  if (entries.length === 0) return null;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary shrink-0" />
            What's New
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-1 max-h-[60vh] overflow-y-auto pr-1">
          {entries.map((entry) => (
            <div key={entry.version}>
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="outline" className="text-xs font-mono">
                  v{entry.version}
                </Badge>
                <span className="text-sm font-medium">{entry.title}</span>
              </div>
              <ul className="space-y-1.5 pl-1">
                {entry.changes.map((change, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-foreground">
                    <span className="text-primary shrink-0 mt-px">•</span>
                    <span className="break-words min-w-0">{change}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button onClick={onClose} className="w-full sm:w-auto">
            Got it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
