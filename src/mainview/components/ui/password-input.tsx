import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input, type InputProps } from "./input";
import { cn } from "@/lib/utils";

interface PasswordInputProps extends Omit<InputProps, "type"> {
	/**
	 * Called when the user reveals the field while it is empty — lets a parent lazily
	 * fetch and fill a saved (masked) secret on demand. Awaited before showing.
	 */
	onReveal?: () => void | Promise<void>;
}

/**
 * A password field with a show/hide eye toggle. Drop-in replacement for
 * <Input type="password" />. The `type` prop is managed internally.
 */
const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
	({ className, onReveal, ...props }, ref) => {
		const [show, setShow] = React.useState(false);
		const toggle = async () => {
			const next = !show;
			if (next && onReveal && !props.value) await onReveal();
			setShow(next);
		};
		return (
			<div className="relative">
				<Input ref={ref} type={show ? "text" : "password"} className={cn("pr-9", className)} {...props} />
				<button
					type="button"
					tabIndex={-1}
					onClick={toggle}
					aria-label={show ? "Hide value" : "Show value"}
					title={show ? "Hide" : "Show"}
					className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
				>
					{show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
				</button>
			</div>
		);
	},
);
PasswordInput.displayName = "PasswordInput";

export { PasswordInput };
