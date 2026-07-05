/**
 * broadcast-method-names.test.ts
 *
 * Structural/static test: every `broadcastToWebview("methodName", ...)` call
 * site (string-literal form) in src/bun must use a name actually declared in
 * WebviewSchema's `messages` block (src/shared/rpc/webview.ts).
 *
 * This directly guards against the exact bug found and fixed in this
 * session: src/bun/agents/tools/pm-tools.ts called
 * `broadcastToWebview("planPresented", ...)` (twice) while the schema only
 * declares `presentPlan`. `broadcastToWebview(method, payload)` does a
 * literal string lookup — `mainWindowRef.webview.rpc.send[method]?.(payload)`
 * — against Electrobun's generated RPC object, which is keyed by the
 * schema's declared names. A mismatched name doesn't throw or warn; the
 * optional-chained lookup on `undefined` just silently no-ops, so the
 * broadcast never reaches the frontend. That bug went unnoticed because
 * nothing checked the string against the schema — this test is that check,
 * covering every broadcastToWebview call site, not just the one that broke.
 *
 * Not covered: call sites that pass a variable/constant instead of a string
 * literal (e.g. Playground's `broadcastToWebview(method, payload)`, or
 * freelance's `FREELANCE_EVENTS.X` constants) — those can't be statically
 * checked this way and aren't part of WebviewSchema in the first place.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const WEBVIEW_SCHEMA_PATH = join(REPO_ROOT, "src/shared/rpc/webview.ts");
const SCAN_ROOT = join(REPO_ROOT, "src/bun");

/**
 * Extracts the top-level keys of the `messages: { ... }` block via a simple
 * brace-depth line scanner (not a full TS parser, but sufficient for this
 * file's consistent formatting — one key per line, `key: {` or `key: {...};`).
 */
function extractMessageKeys(schemaSource: string): string[] {
	const lines = schemaSource.split("\n");
	const startIdx = lines.findIndex((l) => /^\s*messages:\s*\{/.test(l));
	if (startIdx === -1) {
		throw new Error("Could not find a 'messages: {' block in webview.ts — has the schema been restructured?");
	}

	let depth = 0;
	const keys: string[] = [];
	for (let i = startIdx; i < lines.length; i++) {
		const line = lines[i];
		if (i === startIdx) {
			depth += (line.match(/\{/g) || []).length;
			depth -= (line.match(/\}/g) || []).length;
			continue;
		}
		// A top-level message key sits at depth 1 (one level inside "messages: {").
		if (depth === 1) {
			const m = line.match(/^\s*([A-Za-z0-9_]+)\s*:/);
			if (m) keys.push(m[1]);
		}
		depth += (line.match(/\{/g) || []).length;
		depth -= (line.match(/\}/g) || []).length;
		if (depth <= 0) break; // closed the messages block
	}
	return keys;
}

function collectTsFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry.startsWith(".")) continue;
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) collectTsFiles(full, out);
		else if (entry.endsWith(".ts")) out.push(full);
	}
	return out;
}

/** Finds every string-literal-argument `broadcastToWebview("name", ...)` call in a source string. */
function findBroadcastCalls(source: string): string[] {
	const names: string[] = [];
	const regex = /broadcastToWebview\(\s*["']([A-Za-z0-9_]+)["']/g;
	let m: RegExpExecArray | null;
	while ((m = regex.exec(source))) names.push(m[1]);
	return names;
}

describe("extractMessageKeys (parser sanity check)", () => {
	it("finds a broad, expected set of message keys in webview.ts", () => {
		const schemaSource = readFileSync(WEBVIEW_SCHEMA_PATH, "utf-8");
		const keys = extractMessageKeys(schemaSource);
		// Spot-check keys from different areas of the file, including ones
		// added/renamed in this session.
		expect(keys).toContain("presentPlan");
		expect(keys).toContain("shellApprovalRequest");
		expect(keys).toContain("messageQueueUpdated");
		expect(keys).toContain("agentSessionComplete");
		expect(keys).toContain("streamComplete");
		expect(keys).toContain("kanbanTaskUpdated");
		// Regression check for the exact bug: the WRONG name must not appear.
		expect(keys).not.toContain("planPresented");
		expect(keys.length).toBeGreaterThan(30);
	});
});

describe("broadcastToWebview call sites", () => {
	it("every string-literal call uses a name declared in WebviewSchema's messages block", () => {
		const schemaSource = readFileSync(WEBVIEW_SCHEMA_PATH, "utf-8");
		const declaredKeys = new Set(extractMessageKeys(schemaSource));

		const files = collectTsFiles(SCAN_ROOT);
		const problems: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf-8");
			for (const name of findBroadcastCalls(source)) {
				if (!declaredKeys.has(name)) {
					problems.push(
						`${file.slice(REPO_ROOT.length)}: broadcastToWebview("${name}") — "${name}" is not declared in WebviewSchema's messages block`,
					);
				}
			}
		}

		expect(problems).toEqual([]);
	});
});
