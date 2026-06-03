import { useEffect, useState } from "react";
import { rpc } from "@/lib/rpc";
import { CustomAgentChatWidget } from "./custom-agent-chat-widget";

interface ChatAgent {
  id:          string;
  name:        string;
  displayName: string;
  color:       string;
}

/**
 * Fetches all custom agents with "Enable Chat" turned on and renders one
 * floating chat widget for each, stacked above the PM button.
 *
 * The widgets stay MOUNTED regardless of the current page (only their trigger
 * button is gated by `visible`) so their stream listeners keep capturing replies
 * — and flagging them unread — even after the user navigates away from the
 * dashboard mid-conversation. The list (re)fetches on mount and whenever the
 * dashboard becomes visible, so toggling "Enable Chat" in Settings → Agents is
 * reflected without a full reload.
 */
export function CustomAgentChatLauncher({ visible }: { visible: boolean }) {
  const [agents, setAgents] = useState<ChatAgent[]>([]);

  useEffect(() => {
    let cancelled = false;
    rpc.getChatEnabledAgents()
      .then((rows) => { if (!cancelled) setAgents([...rows].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }))); })
      .catch(() => { /* if the call fails, just render nothing */ });
    return () => { cancelled = true; };
  }, [visible]);

  if (agents.length === 0) return null;

  return (
    <>
      {agents.map((a) => (
        <CustomAgentChatWidget
          key={a.id}
          agentName={a.name}
          displayName={a.displayName}
          color={a.color}
          visible={visible}
        />
      ))}
    </>
  );
}
