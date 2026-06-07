import { useState } from "react";
import { Issues } from "./issues";
import { IssueFixerProjectTab } from "../issue-fixer/issue-fixer-tab";
import { useUnreadStore, hasUnreadPrefix } from "../../stores/unread-store";
import { UnreadDot } from "@/components/ui/unread-dot";

type IssueTrackerView = "issues" | "auto-fixer";

const VIEWS: { id: IssueTrackerView; label: string }[] = [
  { id: "issues", label: "Issues" },
  { id: "auto-fixer", label: "Auto Issues Fixer" },
];

/**
 * Top-level "Issue Tracker" tab. Hosts two sub-views:
 *   • Issues     — the multi-source issue list (GitHub/Jira/Linear/GitLab/Trello/Kanboard)
 *   • Auto Fixer — autonomous GitHub-issue → branch/PR resolution (the Issue Fixer)
 */
export function IssueTrackerTab({ projectId }: { projectId: string }) {
  const [view, setView] = useState<IssueTrackerView>("issues");
  // Unread agent activity under Auto Issues Fixer (cleared at its History inner tab).
  const issueFixerUnread = useUnreadStore(hasUnreadPrefix(projectId, "issue-fixer"));

  return (
    <div className="flex flex-col h-full">
      {/* Sub-navigation */}
      <div className="flex items-center gap-0.5 px-4 pt-3 pb-0 border-b overflow-x-auto shrink-0">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-t border-b-2 transition-colors whitespace-nowrap ${
              view === v.id
                ? "border-primary text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {v.label}
            {/* Dot on Auto Fixer when there's unseen activity and it isn't the active view. */}
            {v.id === "auto-fixer" && issueFixerUnread && view !== "auto-fixer" && <UnreadDot />}
          </button>
        ))}
      </div>

      {view === "issues" ? (
        <div className="flex-1 overflow-y-auto p-4">
          <Issues projectId={projectId} />
        </div>
      ) : (
        // Issue Fixer ships its own full-height scroll container + padding.
        <div className="flex-1 overflow-hidden">
          <IssueFixerProjectTab projectId={projectId} />
        </div>
      )}
    </div>
  );
}
