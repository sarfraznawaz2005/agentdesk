import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useChatWidgetsVisibleHere } from "@/lib/use-chat-widgets-scope";
import { ChatPanel } from "./chat-panel";

// Same fixed-circular-button convention as src/mainview/components/dashboard/chat-fab.tsx —
// and, like pm-chat-widget.tsx's trigger pill, the button itself disappears while the panel
// is open (the panel's own header X closes it) instead of sitting behind/above the panel.
export function ChatFab() {
	const [open, setOpen] = useState(false);
	// The persistent ChatLauncherFooter bar only shows on Collections when the
	// "Show chat widgets only on Dashboard" setting is off — clear it only then.
	const footerShowing = useChatWidgetsVisibleHere();

	return (
		<>
			{!open && (
				<button
					type="button"
					onClick={() => setOpen(true)}
					className={cn(
						"fixed right-6 z-[57] flex h-14 w-14 items-center justify-center rounded-full",
						footerShowing ? "bottom-12" : "bottom-6",
						"bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors",
					)}
					aria-label="Open collections chat"
				>
					<MessageSquare className="h-6 w-6" strokeWidth={2.5} />
				</button>
			)}
			{/* Always mounted (even while closed) so an in-flight stream's event
			    listeners stay attached — only the panel's own JSX hides when !open. */}
			<ChatPanel open={open} onClose={() => setOpen(false)} footerShowing={footerShowing} />
		</>
	);
}
