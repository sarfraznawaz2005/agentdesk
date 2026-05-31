// ---------------------------------------------------------------------------
// JSON-RPC 2.0 transport over stdio with Content-Length framing
// ---------------------------------------------------------------------------

import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, JsonRpcNotification } from "./types";

/** Bun Subprocess with piped stdin/stdout */
interface StdioProcess {
	stdin: { write(data: string | Uint8Array): number | undefined } | null | undefined;
	stdout: ReadableStream<Uint8Array> | null | undefined;
}

const HEADER_DELIMITER = "\r\n\r\n";
const CONTENT_LENGTH_RE = /Content-Length:\s*(\d+)/i;
const DEFAULT_TIMEOUT = 30_000;

interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

type NotificationHandler = (method: string, params: unknown) => void;

/**
 * JSON-RPC 2.0 transport over stdio.
 *
 * Sends requests/notifications to a child process stdin, reads responses
 * from stdout using Content-Length framing. Supports request timeouts
 * and notification handlers.
 */
export class JsonRpcTransport {
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private buffer = Buffer.alloc(0);
	private onNotification: NotificationHandler | null = null;
	private disposed = false;

	constructor(private process: StdioProcess) {
		this.startReading();
	}

	/** Register a handler for incoming notifications (no id field). */
	setNotificationHandler(handler: NotificationHandler): void {
		this.onNotification = handler;
	}

	/** Send a request and wait for the response. */
	async sendRequest(method: string, params?: unknown, timeout = DEFAULT_TIMEOUT): Promise<unknown> {
		if (this.disposed) throw new Error("Transport disposed");

		const id = this.nextId++;
		const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		this.writeMessage(message);

		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`LSP request "${method}" timed out after ${timeout}ms`));
			}, timeout);

			this.pending.set(id, { resolve, reject, timer });
		});
	}

	/** Send a notification (no response expected). */
	sendNotification(method: string, params?: unknown): void {
		if (this.disposed) return;
		const message: JsonRpcNotification = { jsonrpc: "2.0", method, params };
		this.writeMessage(message);
	}

	/** Clean up: reject pending requests, stop reading. */
	dispose(): void {
		this.disposed = true;
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Transport disposed"));
			this.pending.delete(id);
		}
	}

	// ── Private ────────────────────────────────────────────────────────────

	private writeMessage(message: JsonRpcMessage): void {
		const body = JSON.stringify(message);
		const header = `Content-Length: ${Buffer.byteLength(body)}${HEADER_DELIMITER}`;
		try {
			this.process.stdin?.write(header + body);
		} catch {
			// Process may have exited
		}
	}

	private startReading(): void {
		const stdout = this.process.stdout;
		if (!stdout) return;

		(async () => {
			const reader = stdout.getReader();
			try {
				while (!this.disposed) {
					const { done, value } = await reader.read();
					if (done) break;
					this.buffer = Buffer.concat([this.buffer, Buffer.from(value)]);
					this.processBuffer();
				}
			} catch {
				// Stream closed
			} finally {
				reader.releaseLock();
			}
		})();
	}

	private processBuffer(): void {
		while (true) {
			const headerEnd = this.buffer.indexOf(HEADER_DELIMITER);
			if (headerEnd === -1) break;

			const header = this.buffer.subarray(0, headerEnd).toString("utf-8");
			const match = CONTENT_LENGTH_RE.exec(header);
			if (!match) {
				// Malformed header — skip past delimiter
				this.buffer = this.buffer.subarray(headerEnd + HEADER_DELIMITER.length);
				continue;
			}

			const contentLength = parseInt(match[1], 10);
			const bodyStart = headerEnd + HEADER_DELIMITER.length;

			if (this.buffer.length < bodyStart + contentLength) {
				// Not enough data yet — wait for more
				break;
			}

			const bodyStr = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf-8");
			this.buffer = this.buffer.subarray(bodyStart + contentLength);

			try {
				const message = JSON.parse(bodyStr) as JsonRpcMessage;
				this.handleMessage(message);
			} catch {
				// Malformed JSON — skip
			}
		}
	}

	private handleMessage(message: JsonRpcMessage): void {
		// Response (has id, no method)
		if ("id" in message && message.id !== null && !("method" in message)) {
			const response = message as JsonRpcResponse;
			const pending = this.pending.get(response.id as number);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(response.id as number);
				if (response.error) {
					pending.reject(new Error(`LSP error ${response.error.code}: ${response.error.message}`));
				} else {
					pending.resolve(response.result);
				}
			}
			return;
		}

		// Notification (no id, has method)
		if ("method" in message && !("id" in message)) {
			const notification = message as JsonRpcNotification;
			this.onNotification?.(notification.method, notification.params);
			return;
		}

		// Server-initiated request (has id + method) — we don't handle these yet
		// Respond with method-not-found
		if ("id" in message && "method" in message) {
			const response: JsonRpcResponse = {
				jsonrpc: "2.0",
				id: (message as JsonRpcRequest).id,
				error: { code: -32601, message: "Method not found" },
			};
			this.writeMessage(response);
		}
	}
}
