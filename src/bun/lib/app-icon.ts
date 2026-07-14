import { existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { dlopen, FFIType, ptr, JSCallback } from "bun:ffi";

// Extracted from index.ts so a second window (Quick Chat) can set its own
// taskbar/titlebar icon without importing index.ts (whose top-level code has
// app-startup side effects that must never run twice — see lib/main-view-url.ts).

// App icon path — used for the Win32 titlebar icon FFI call below, and for
// the Windows "Open in AgentDesk" Explorer context-menu entry
// (quick-chat/os-integration.ts).
// Production: bundled as Resources/app.ico next to the bun binary.
// Dev / fallback: source assets/icon.ico.
const bundledIconPath = join(dirname(process.argv0), "..", "Resources", "app", "app.ico");
export const appIconPath = existsSync(bundledIconPath)
	? bundledIconPath
	: resolve(import.meta.dir, "../../../assets/icon.ico");

const toWide = (s: string) => {
	const b = Buffer.alloc((s.length + 1) * 2);
	b.write(s, 0, "utf16le");
	return b;
};

/**
 * Brands a native window's titlebar/taskbar icon, and — since it already
 * needs to locate the window — optionally sets its FINAL display title too,
 * bypassing a real Electrobun bug: `BrowserWindow.setTitle()`/its `title`
 * constructor option both silently hard-truncate at exactly 35 characters
 * (confirmed via live measurement — `(Get-Process ...).MainWindowTitle`
 * showed a 38-char title cut to exactly 35 chars, byte-for-byte, on every
 * test). Windows itself has no such limit (SetWindowTextW accepts arbitrary
 * length) — this is Electrobun's own native wrapper, not fixable from here.
 *
 * `findByTitle` is what FindWindowW searches for (exact match, first result
 * only) — callers needing a title LONGER than 35 chars should pass a short,
 * merely-unique marker here (see quick-chat/window.ts's shortMarkerFor,
 * keyed by the window's own numeric id) via win.setTitle(marker) right
 * before calling this, then pass the real desired text as `displayTitle`:
 * once the window is found via the short marker, this calls SetWindowTextW
 * directly (our own raw call, NOT Electrobun's wrapper) to set the
 * untruncated real title. If `displayTitle` is omitted, `findByTitle` is
 * left as the final title (the main window's case — always short).
 *
 * Windows-only, no-op elsewhere. Icon-setting is STILL NEEDED despite
 * electrobun.config.ts's build.win.icon embedding the icon into
 * launcher.exe/bun.exe (via the scripts.postBuild workaround — see that
 * script's comment for why the built-in embed step alone doesn't do it):
 * confirmed via live UI inspection that Electrobun's native window class
 * doesn't pick up the owning exe's embedded resource icon for its
 * taskbar/titlebar icon at all — File Explorer shows the new icon on the
 * exe file itself, but the running window keeps showing Electrobun's own
 * default icon until this runs.
 */
export function brandWindow(findByTitle: string, iconFilePath: string, displayTitle?: string): void {
	if (process.platform !== "win32") return;
	try {
		const user32 = dlopen("user32.dll", {
			FindWindowW:    { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			SendMessageW:   { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr], returns: FFIType.ptr },
			LoadImageW:     { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.i32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
			SetWindowTextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		});

		const WM_SETICON      = 0x0080;
		const IMAGE_ICON      = 1;
		const LR_LOADFROMFILE = 0x0010;
		const LR_DEFAULTSIZE  = 0x0040;

		const hwnd = user32.symbols.FindWindowW(null, ptr(toWide(findByTitle)));
		if (!hwnd) return;

		if (displayTitle && displayTitle !== findByTitle) {
			user32.symbols.SetWindowTextW(hwnd, ptr(toWide(displayTitle)));
		}

		const hIcon = user32.symbols.LoadImageW(null, ptr(toWide(iconFilePath)), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
		if (hIcon) {
			user32.symbols.SendMessageW(hwnd, WM_SETICON, 1, hIcon); // ICON_BIG
			user32.symbols.SendMessageW(hwnd, WM_SETICON, 0, hIcon); // ICON_SMALL
		}
	} catch {
		// Non-fatal — icon/title cosmetics only
	}
}

/**
 * Forces real OS keyboard input focus into a Quick Chat window's WebView2
 * content, by title (exact FindWindowW match — same caveat as brandWindow:
 * call with whatever the window's CURRENT title actually is).
 *
 * Live-diagnosed via a CDP session attached to the actual running window
 * plus raw user32 window-tree enumeration (not guesswork). The top-level
 * window genuinely IS the OS foreground window on open, and a plain
 * SetFocus — even done correctly, cross-thread-attached via
 * AttachThreadInput (a documented Win32 requirement: a thread can't
 * SetFocus a window owned by a different thread's message queue without
 * this), even targeting the EXACT render widget HWND (WebView2's input-
 * receiving surface is nested several levels below the top-level window:
 * top-level -> Static -> Chrome_WidgetWin_0 -> Chrome_WidgetWin_1 ->
 * Chrome_RenderWidgetHostHWND; EnumChildWindows is required to reach it,
 * since it's not a direct child) — still left `document.hasFocus()` false
 * and real OS-level keystrokes (verified with Windows Forms SendKeys, not
 * a synthetic DOM/CDP event) did not land in the chat textarea.
 *
 * A simulated mouse click on the render widget DID fix it (Chromium's own
 * mouse-down handling correctly engages its internal focus state where raw
 * SetFocus alone doesn't) — but a left OR right click is unsafe here: left
 * lands wherever the render widget's client-area center happens to be,
 * which once was a "quick start" prompt suggestion and auto-submitted a
 * full template to the PM; right reliably opens a real context menu, which
 * the app must never suppress (that menu is WebView2's only built-in
 * copy/paste, needed everywhere, always). Posting WM_SETFOCUS directly
 * (no mouse event at all) was tried as a safer alternative and confirmed
 * live NOT to work — document.hasFocus() stayed false and keystrokes still
 * didn't land, so Chromium's focus engagement genuinely requires a real
 * mouse event, not just a message.
 *
 * What's used instead: a simulated MIDDLE click. Per the DOM spec, the
 * synthetic "click" event only ever fires for the primary (left) button,
 * and "contextmenu" only for the right button — a middle-click fires
 * neither, only "mousedown"/"mouseup"/"auxclick" with button=1, which
 * nothing in this app's UI listens for. It's still a genuine enough mouse
 * interaction to engage Chromium's internal focus state the same way a
 * left or right click did, without being able to activate any element or
 * open any menu.
 */
export function focusWebviewContent(title: string): void {
	if (process.platform !== "win32") return;
	try {
		const user32 = dlopen("user32.dll", {
			FindWindowW:              { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			SetForegroundWindow:      { args: [FFIType.ptr], returns: FFIType.i32 },
			SetFocus:                 { args: [FFIType.ptr], returns: FFIType.ptr },
			GetWindowThreadProcessId: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u32 },
			AttachThreadInput:        { args: [FFIType.u32, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
			GetClassNameW:            { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			EnumChildWindows:         { args: [FFIType.ptr, FFIType.function, FFIType.ptr], returns: FFIType.i32 },
			GetClientRect:            { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			SendMessageW:             { args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.u64], returns: FFIType.ptr },
		});
		const kernel32 = dlopen("kernel32.dll", {
			GetCurrentThreadId: { args: [], returns: FFIType.u32 },
		});

		const topHwnd = user32.symbols.FindWindowW(null, ptr(toWide(title)));
		if (!topHwnd) return;

		let renderHwnd: number | bigint | null = null;
		const classBuf = Buffer.alloc(256);
		const classPtr = ptr(classBuf);
		const enumProc = new JSCallback(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(hwnd: any) => {
				const len = user32.symbols.GetClassNameW(hwnd, classPtr, 128);
				const cls = classBuf.toString("utf16le", 0, len * 2);
				if (cls === "Chrome_RenderWidgetHostHWND") {
					renderHwnd = hwnd;
					return 0; // FALSE — stop enumeration, found it
				}
				return 1; // TRUE — keep enumerating
			},
			{ args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		);
		try {
			user32.symbols.EnumChildWindows(topHwnd, enumProc.ptr, null);
		} finally {
			enumProc.close();
		}
		const focusTarget = renderHwnd ?? topHwnd;

		user32.symbols.SetForegroundWindow(topHwnd);

		const targetThreadId = user32.symbols.GetWindowThreadProcessId(focusTarget, null);
		const currentThreadId = kernel32.symbols.GetCurrentThreadId();
		if (targetThreadId && targetThreadId !== currentThreadId) {
			const attached = user32.symbols.AttachThreadInput(currentThreadId, targetThreadId, 1);
			try {
				user32.symbols.SetFocus(focusTarget);
			} finally {
				if (attached) user32.symbols.AttachThreadInput(currentThreadId, targetThreadId, 0);
			}
		} else {
			user32.symbols.SetFocus(focusTarget);
		}

		if (renderHwnd) {
			const rectBuf = Buffer.alloc(16); // RECT: left, top, right, bottom (4x i32)
			if (user32.symbols.GetClientRect(renderHwnd, ptr(rectBuf))) {
				const left = rectBuf.readInt32LE(0);
				const top = rectBuf.readInt32LE(4);
				const right = rectBuf.readInt32LE(8);
				const bottom = rectBuf.readInt32LE(12);
				const x = Math.floor((left + right) / 2);
				const y = Math.floor((top + bottom) / 2);
				const lParam = (y << 16) | (x & 0xffff);
				const WM_MBUTTONDOWN = 0x0207;
				const WM_MBUTTONUP   = 0x0208;
				const MK_MBUTTON     = 0x0010;
				user32.symbols.SendMessageW(renderHwnd, WM_MBUTTONDOWN, MK_MBUTTON, lParam);
				user32.symbols.SendMessageW(renderHwnd, WM_MBUTTONUP, 0, lParam);
			}
		}
	} catch {
		// Non-fatal — focus is best-effort
	}
}

