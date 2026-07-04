import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "@/components/ui/toast";
import { useChatStore } from "@/stores/chat-store";

/**
 * Global listener that toasts an entire agent-dispatch session finishing in a
 * project the user is NOT currently viewing (the visible project's board/chat
 * already show this live). Fires once per project per idle-settle — not once
 * per kanban task — via the agentSessionComplete broadcast, which itself only
 * fires when the project's PM AND all its agents have gone idle (mirrors the
 * existing "Session Complete" desktop notification's trigger). Renders
 * nothing; mounted once in AppShell so it survives navigation.
 *
 * "Currently viewing" is the chat store's activeProjectId — the same signal
 * ProjectPage declares on mount and that gates cross-project broadcasts.
 */
export function AgentSessionToast() {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: Event) => {
      const { projectId, projectName } = (e as CustomEvent<{
        projectId: string;
        projectName: string;
      }>).detail;

      if (useChatStore.getState().activeProjectId === projectId) return;

      toast(
        "success",
        `All agents completed in ${projectName}`,
        {
          label: "Open project",
          onClick: () => navigate({ to: "/project/$projectId", params: { projectId } }),
        },
        { autoDismiss: true },
      );
    };

    window.addEventListener("agentdesk:agent-session-complete", handler);
    return () => window.removeEventListener("agentdesk:agent-session-complete", handler);
  }, [navigate]);

  return null;
}
