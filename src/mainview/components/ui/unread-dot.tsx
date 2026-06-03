import { cn } from "@/lib/utils";
import { Tip } from "@/components/ui/tooltip";

/**
 * The single, consistent unread indicator used everywhere — dashboard project cards,
 * chat-widget launchers, and project tabs/sub-tabs. A bright pulsing red dot with a
 * theme-aware ring (so it reads the same on light/dark and on any background/button)
 * and a built-in tooltip. Pass `className` only for positioning (e.g.
 * `absolute -top-1 -right-1`); pass `tooltip` to override the generic label.
 */
export function UnreadDot({
	className,
	tooltip = "New activity you haven't seen yet",
	side = "bottom",
}: {
	className?: string;
	tooltip?: string;
	side?: "top" | "bottom" | "left" | "right";
}) {
	return (
		<Tip content={tooltip} side={side}>
			<span className={cn("relative inline-flex h-2.5 w-2.5 shrink-0", className)} aria-label="Unread">
				<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
				<span className="relative inline-flex h-full w-full rounded-full bg-red-500 ring-2 ring-background" />
			</span>
		</Tip>
	);
}
