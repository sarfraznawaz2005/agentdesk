#!/usr/bin/env node
// live-browser launcher — cross-platform (Windows / macOS / Linux).
// ---------------------------------------------------------------------------
// Starts Chrome / Edge / Brave with a DEDICATED, PERSISTENT debugging profile
// and NO automation flags, so the live-browser skill can drive a real,
// human-looking session.
//
//   - Pass ONLY --remote-debugging-port (never --enable-automation): no
//     "controlled by automated test software" banner, navigator.webdriver=false.
//   - Persistent --user-data-dir: log into sites once, sessions survive.
//   - Picks an uncommon FREE port and PERSISTS it (live-browser.port) so the
//     client connects to OUR instance, not a foreign debug browser on 9222.
//   - Chrome 136+ refuses --remote-debugging-port against the default profile,
//     which is exactly why we use a dedicated --user-data-dir.
//
// Re-running is a no-op if our browser is already up.
import { spawn, execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import {
  DEFAULT_PORT, defaultProfileDir, readPort, writePort, browserInfo, findFreePort,
} from './lib.mjs';

const HELP = `live-browser launcher

Usage: node launch.mjs [--browser auto|chrome|edge|brave] [--port N] [--url URL] [--profile-dir DIR]

Starts a real Chrome/Edge/Brave with a dedicated persistent profile and a CDP
debugging port (no automation flags). Re-running is a no-op if already up.`;

function parseArgs(argv) {
  const out = { browser: 'auto', port: null, url: '', profileDir: '', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--browser') out.browser = argv[++i];
    else if (a === '--port') out.port = parseInt(argv[++i], 10);
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--profile-dir') out.profileDir = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

function browserCandidates(name) {
  const plat = process.platform;
  if (plat === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || resolve(homedir(), 'AppData/Local');
    switch (name) {
      case 'chrome': return [
        resolve(pf, 'Google/Chrome/Application/chrome.exe'),
        resolve(pf86, 'Google/Chrome/Application/chrome.exe'),
        resolve(local, 'Google/Chrome/Application/chrome.exe'),
      ];
      case 'edge': return [
        resolve(pf86, 'Microsoft/Edge/Application/msedge.exe'),
        resolve(pf, 'Microsoft/Edge/Application/msedge.exe'),
      ];
      case 'brave': return [
        resolve(pf, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
        resolve(pf86, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
        resolve(local, 'BraveSoftware/Brave-Browser/Application/brave.exe'),
      ];
    }
  } else if (plat === 'darwin') {
    switch (name) {
      case 'chrome': return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
      case 'edge': return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
      case 'brave': return ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'];
    }
  } else {
    switch (name) {
      case 'chrome': return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
      case 'edge': return ['microsoft-edge', 'microsoft-edge-stable'];
      case 'brave': return ['brave-browser', 'brave'];
    }
  }
  return [];
}

// Resolve a candidate to a runnable path. Absolute paths are existence-checked;
// bare command names (Linux) are resolved through PATH.
function resolveExe(candidate) {
  if (candidate.includes('/') || candidate.includes('\\')) {
    return existsSync(candidate) ? candidate : null;
  }
  try {
    const cmd = process.platform === 'win32' ? `where ${candidate}` : `command -v ${candidate}`;
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' })
      .trim().split('\n')[0].trim();
    return out || null;
  } catch {
    return null;
  }
}

function findBrowser(name) {
  for (const c of browserCandidates(name)) {
    const r = resolveExe(c);
    if (r) return r;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); return; }

  const profileDir = args.profileDir || defaultProfileDir();
  try { mkdirSync(profileDir, { recursive: true }); } catch {}
  const host = process.env.CDP_HOST || '127.0.0.1';

  // 1) Determine the port to use.
  let port = args.port;
  if (!port) {
    // Reuse our persisted instance if it's still alive.
    const persisted = readPort();
    if (persisted) {
      try {
        const info = await browserInfo(persisted, host);
        console.log(`live-browser already running on port ${persisted} (${info.Browser}).`);
        console.log(`Profile: ${profileDir}`);
        return;
      } catch { /* persisted port is dead — relaunch on a fresh free port */ }
    }
    port = await findFreePort(DEFAULT_PORT);
  } else {
    // Explicit port: reuse if it's already serving CDP.
    try {
      const info = await browserInfo(port, host);
      console.log(`live-browser already running on port ${port} (${info.Browser}).`);
      writePort(port);
      return;
    } catch { /* nothing there yet — launch below */ }
  }

  // 2) Find a browser binary.
  const order = args.browser === 'auto' ? ['chrome', 'edge', 'brave'] : [args.browser];
  let exe = null;
  let picked = null;
  for (const b of order) {
    exe = findBrowser(b);
    if (exe) { picked = b; break; }
  }
  if (!exe) {
    console.error(`No supported browser found (looked for: ${order.join(', ')}). Install Chrome or Edge, or pass --browser.`);
    process.exit(1);
  }

  // 3) Launch detached with NO automation flags.
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (args.url) chromeArgs.push(args.url);
  // cwd MUST be outside the app/build tree: this browser is detached and may
  // outlive the app, and a running process locks its working directory on
  // Windows (which would block the next `electrobun` build with EBUSY). The
  // persistent profile dir is a safe, always-present, app-independent location.
  const child = spawn(exe, chromeArgs, { detached: true, stdio: 'ignore', cwd: profileDir });
  child.unref();

  // 4) Wait for the CDP endpoint, then persist the port.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const info = await browserInfo(port, host);
      writePort(port);
      console.log(`live-browser started: ${picked} (${info.Browser})`);
      console.log(`Port: ${port}   Profile: ${profileDir}`);
      console.log('First run? Log into your sites in this window once — the profile persists, so you stay signed in.');
      return;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  console.error(`Browser launched but the CDP endpoint did not come up on port ${port} within 20s.`);
  process.exit(1);
}

main().catch((e) => { console.error(e?.message || String(e)); process.exit(1); });
