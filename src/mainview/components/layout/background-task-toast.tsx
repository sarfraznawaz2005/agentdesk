import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "@/components/ui/toast";
import { useChatStore } from "@/stores/chat-store";

/**
 * Global listener that toasts task completions happening in a project the user
 * is NOT currently viewing (the visible project's board/unread dots already
 * cover in-project completions). Renders nothing; mounted once in AppShell so
 * it survives navigation.
 *
 * "Currently viewing" is the chat store's activeProjectId — the same signal
 * ProjectPage declares on mount and that gates cross-project broadcasts.
 */
export function BackgroundTaskToast() {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: Event) => {
      const { projectId, taskTitle, projectName } = (e as CustomEvent<{
        projectId: string;
        taskId: string;
        taskTitle: string;
        projectName: string;
      }>).detail;

      if (useChatStore.getState().activeProjectId === projectId) return;

      toast(
        "success",
        `Task completed in ${projectName}: ${taskTitle}`,
        {
          label: "Open project",
          onClick: () => navigate({ to: "/project/$projectId", params: { projectId } }),
        },
        { autoDismiss: true },
      );
    };

    window.addEventListener("agentdesk:task-completed", handler);
    return () => window.removeEventListener("agentdesk:task-completed", handler);
  }, [navigate]);

  return null;
}
