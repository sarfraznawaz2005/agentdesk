/**
 * Frontend global error handlers.
 *
 * Catches unhandled JS errors and promise rejections, forwards them to the
 * bun process via the `logClientError` RPC message so they end up in the
 * same error.log file as backend errors.
 */
import { rpc } from "./rpc";

export function initClientErrorHandler(): void {
	window.onerror = (
		_event: Event | string,
		source?: string,
		lineno?: number,
		colno?: number,
		error?: Error,
	) => {
		const message = error?.message ?? String(_event);

		// "Script error." with no source is a cross-origin script error sanitized
		// by the browser — no actionable info available.
		if (message === "Script error." && !source) return false;

		const stack =
			error?.stack ?? (source ? `at ${source}:${lineno}:${colno}` : undefined);

		console.error("[global:onerror]", message);
		rpc.logClientError("onerror", message, stack);
	};

	window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
		const err =
			event.reason instanceof Error
				? event.reason
				: new Error(String(event.reason));

		console.error("[global:unhandledrejection]", err.message);
		rpc.logClientError("unhandledRejection", err.message, err.stack);
	});
}
