import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "@/components/ui/toast";
import { useChatStore } from "@/stores/chat-store";

/**
 * Global listener that toasts a shell-command or plan approval request
 * waiting in a project the user is NOT currently viewing. Unlike
 * agentSessionComplete (informational — the visible project already shows
 * everything live), these two block an agent until the user acts, and
 * neither the shell-approval card nor the plan-approval card render outside
 * their own project's chat — so without this, the user has zero in-app
 * signal that something needs them elsewhere. Shell approval also fires an
 * OS desktop notification (plan approval now does too, as of this toast's
 * companion change), but neither deep-links back into the app; this does.
 *
 * "Open" sets pendingConversationTarget (consumed by ProjectPage's
 * conversation auto-select effect once that project's conversations finish
 * loading) and navigates — landing on the EXACT conversation waiting for
 * approval, not just "some conversation in that project."
 *
 * Action toasts are sticky by default (see toast.tsx) — intentional here,
 * since these are time-sensitive/blocking, not just informational.
 * Mounted once in AppShell so it survives navigation. Renders nothing.
 */
export function CrossProjectApprovalToast() {
  const navigate = useNavigate();

  useEffect(() => {
    function openConversation(projectId: string, conversationId: string) {
      useChatStore.getState().setPendingConversationTarget({ projectId, conversationId });
      navigate({ to: "/project/$projectId", params: { projectId } });
    }

    function onShellApprovalRequest(e: Event) {
      const { projectId, conversationId, agentName } = (e as CustomEvent<{
        requestId: string;
        projectId: string;
        conversationId: string;
        agentId: string;
        agentName: string;
        command: string;
        timestamp: string;
      }>).detail;

      if (useChatStore.getState().activeProjectId === projectId) return;

      toast(
        "warning",
        `${agentName} needs shell approval in another project`,
        {
          label: "Open",
          onClick: () => openConversation(projectId, conversationId),
        },
      );
    }

    function onPlanPresented(e: Event) {
      const { projectId, conversationId, plan } = (e as CustomEvent<{
        projectId: string;
        conversationId: string;
        plan: { title: string; content: string };
      }>).detail;

      if (useChatStore.getState().activeProjectId === projectId) return;

      toast(
        "info",
        `Plan ready for approval in another project: ${plan.title}`,
        {
          label: "Open",
          onClick: () => openConversation(projectId, conversationId),
        },
      );
    }

    window.addEventListener("agentdesk:shell-approval-request", onShellApprovalRequest);
    window.addEventListener("agentdesk:plan-presented", onPlanPresented);
    return () => {
      window.removeEventListener("agentdesk:shell-approval-request", onShellApprovalRequest);
      window.removeEventListener("agentdesk:plan-presented", onPlanPresented);
    };
  }, [navigate]);

  return null;
}
