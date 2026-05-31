/**
 * server.test.ts
 *
 * Tests for the Playground static preview server (src/bun/playground/server.ts).
 *
 * Covers the behaviours that matter for correctness + security:
 *  - serving files and the directory root (index.html)
 *  - correct MIME types
 *  - directory-traversal protection (403) — security-critical
 *  - 404 for genuinely missing files
 *  - SPA fallback for extension-less routes
 *  - the PDF.js viewer route (since WebView2 blocks raw PDF iframes)
 *  - injection of the console-capture shim (incl. the Electrobun-noise filter)
 *
 * Test files are written BEFORE the server starts so the file watcher never fires during
 * the run (it would otherwise dynamically import engine-manager → Electrobun). The watcher
 * is also stopped explicitly for belt-and-suspenders.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { PLAYGROUND_FILES_DIR, wipePlayground } from "../../src/bun/playground/paths";
import {
	startPlaygroundServer,
	shutdownPlaygroundServer,
	stopPlaygroundFileWatcher,
	PLAYGROUND_SERVER_PORT,
} from "../../src/bun/playground/server";

let base: string;

beforeAll(() => {
	wipePlayground();
	writeFileSync(
		path.join(PLAYGROUND_FILES_DIR, "index.html"),
		"<!DOCTYPE html><html><head><title>t</title></head><body>hello-world</body></html>",
	);
	writeFileSync(path.join(PLAYGROUND_FILES_DIR, "style.css"), "body{color:red}");
	mkdirSync(path.join(PLAYGROUND_FILES_DIR, "sub"), { recursive: true });
	writeFileSync(path.join(PLAYGROUND_FILES_DIR, "sub", "page.html"), "<html><body>sub-page</body></html>");
	writeFileSync(path.join(PLAYGROUND_FILES_DIR, "report.pdf"), "%PDF-1.4 not-a-real-pdf");

	startPlaygroundServer();
	stopPlaygroundFileWatcher(); // don't let fs.watch fire engine-manager imports mid-test
	base = `http://127.0.0.1:${PLAYGROUND_SERVER_PORT}`;
});

afterAll(() => {
	shutdownPlaygroundServer();
	wipePlayground();
});

describe("playground static server", () => {
	it("serves index.html as HTML and injects the console-capture shim + Electrobun-noise filter", async () => {
		const res = await fetch(`${base}/index.html`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("hello-world");
		expect(html).toContain("__agentdeskPlaygroundConsole"); // shim present
		expect(html).toContain("0x80070490"); // Electrobun bridge-noise filter present
	});

	it("serves the directory root as index.html", async () => {
		const res = await fetch(`${base}/`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("hello-world");
	});

	it("serves a nested file", async () => {
		const res = await fetch(`${base}/sub/page.html`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("sub-page");
	});

	it("serves CSS with the correct MIME type and no shim injection", async () => {
		const res = await fetch(`${base}/style.css`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/css");
		const css = await res.text();
		expect(css).toContain("color:red");
		expect(css).not.toContain("__agentdeskPlaygroundConsole");
	});

	it("blocks directory traversal with 403", async () => {
		// %2f-encoded slashes survive URL normalization, so this reaches resolveSafe and must be rejected.
		const res = await fetch(`${base}/..%2f..%2f..%2fsecret.txt`);
		expect(res.status).toBe(403);
	});

	it("returns 404 for a missing file with an extension", async () => {
		const res = await fetch(`${base}/does-not-exist.png`);
		expect(res.status).toBe(404);
	});

	it("falls back to index.html for extension-less SPA routes", async () => {
		const res = await fetch(`${base}/some/client/route`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("hello-world");
	});

	it("serves a PDF.js viewer for the /__pdf route pointing at the file", async () => {
		const res = await fetch(`${base}/__pdf?file=report.pdf`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("pdfjsLib"); // uses PDF.js
		expect(html).toContain("/report.pdf"); // loads the requested file
	});

	it("returns 400 for /__pdf without a file param", async () => {
		const res = await fetch(`${base}/__pdf`);
		expect(res.status).toBe(400);
	});
});
