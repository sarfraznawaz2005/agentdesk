// Shared helpers for the live-browser skill scripts (launch.mjs + cdp.mjs).
// Keeps the data dir, profile dir, port-file location, and CDP discovery
// identical across the launcher and the client so they always agree.
import { homedir } from 'os';
import { resolve } from 'path';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import net from 'net';

// Uncommon default port. Deliberately NOT 9222 (the Chrome convention everyone
// uses — chrome-devtools-mcp, Puppeteer, VS Code), nor 9229 (Node inspector),
// 5173 (Vite), 3000, etc. An uncommon port is usually free on the first try, so
// we connect to OUR dedicated-profile browser rather than someone else's. The
// launcher persists whatever port it actually used (see writePort) so the client
// never has to guess.
export const DEFAULT_PORT = 9756;

// Per-OS AgentDesk data directory (sibling of the persistent browser profile).
export function dataDir() {
  if (process.platform === 'win32') {
    return resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData/Local'), 'AgentDesk');
  }
  if (process.platform === 'darwin') {
    return resolve(homedir(), 'Library/Application Support/AgentDesk');
  }
  return resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), '.cache'), 'agentdesk');
}

export function defaultProfileDir() {
  return process.env.LIVE_BROWSER_PROFILE || resolve(dataDir(), 'live-browser-profile');
}

export function portFilePath() {
  return resolve(dataDir(), 'live-browser.port');
}

export function readPort() {
  try {
    const p = parseInt(readFileSync(portFilePath(), 'utf8').trim(), 10);
    return Number.isInteger(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

export function writePort(port) {
  try { mkdirSync(dataDir(), { recursive: true }); } catch {}
  writeFileSync(portFilePath(), String(port), 'utf8');
}

// Full /json/version payload from a running browser, or throws if none is there.
export async function browserInfo(port, host = '127.0.0.1') {
  const res = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(2500) });
  if (!res.ok) throw new Error(`/json/version returned HTTP ${res.status}`);
  return res.json();
}

// Browser-level CDP WebSocket URL, or throws if no CDP browser is on the port.
export async function wsUrlFromPort(port, host = '127.0.0.1') {
  const info = await browserInfo(port, host);
  if (!info.webSocketDebuggerUrl) throw new Error('No webSocketDebuggerUrl in /json/version');
  return info.webSocketDebuggerUrl;
}

// True if nothing is listening on the TCP port (free to bind).
export function portFree(port, host = '127.0.0.1') {
  return new Promise((res) => {
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (free) => { if (done) return; done = true; sock.destroy(); res(free); };
    sock.on('connect', () => finish(false));
    sock.on('error', () => finish(true));
    setTimeout(() => finish(true), 600);
  });
}

export async function findFreePort(start = DEFAULT_PORT, span = 40) {
  for (let p = start; p < start + span; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error(`No free port found in range ${start}-${start + span}`);
}
