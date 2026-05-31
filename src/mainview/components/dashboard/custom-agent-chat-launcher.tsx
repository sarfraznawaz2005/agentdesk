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
 * floating chat widget for each, stacked above the PM button. The list
 * refreshes whenever the dashboard page becomes visible so toggling the
 * setting in Settings → Agents is reflected without a full reload.
 */
export function CustomAgentChatLauncher({ visible }: { visible: boolean }) {
  const [agents, setAgents] = useState<ChatAgent[]>([]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    rpc.getChatEnabledAgents()
      .then((rows) => { if (!cancelled) setAgents([...rows].sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }))); })
      .catch(() => { /* if the call fails, just render nothing */ });
    return () => { cancelled = true; };
  }, [visible]);

  if (!visible || agents.length === 0) return null;

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
