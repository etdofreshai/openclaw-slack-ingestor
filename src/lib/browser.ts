/**
 * Chromium CDP browser management for Slack session capture.
 * Based on gemini-test pattern — headless browser with remote debugging.
 */
import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";
import http from "http";

const PROFILE_DIR = resolve(process.cwd(), ".chrome-profile");
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
const CDP_PORT = 9223; // Use different port than gemini-test to avoid conflicts
const CDP_BASE = `http://localhost:${CDP_PORT}`;

// Suppress harmless Chromium stderr noise in containerized environments
const SUPPRESSED_PATTERNS = [
  /Failed to connect to.*bus/i,
  /D-Bus.*connection/i,
  /GDBus.*Error/i,
  /Cannot autolaunch D-Bus/i,
  /org\.freedesktop\.DBus/i,
  /lsb_release.*failed/i,
  /ERROR:.*bus/i,
  /libdbus.*failed/i,
  /Desktop portal.*failed/i,
  /XDG_PORTAL/i,
  /cannot open display/i,
  /Gtk-WARNING.*cannot open/i,
];

function shouldSuppress(line: string): boolean {
  return SUPPRESSED_PATTERNS.some(p => p.test(line));
}

let chromiumProc: ChildProcess | null = null;
let starting: Promise<void> | null = null;

export function cdpRequest(method: string, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${CDP_BASE}${path}`, { method }, (res) => {
      let d = "";
      res.on("data", (c: Buffer) => (d += c));
      res.on("end", () => {
        try { resolve(d ? JSON.parse(d) : {}); } catch { resolve(d); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitForCdp(timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { await cdpRequest("GET", "/json/version"); return; } catch {}
    await sleep(300);
  }
  throw new Error("Chromium CDP did not become available");
}

export async function ensureChromium(): Promise<void> {
  if (chromiumProc && !chromiumProc.killed) {
    try { await cdpRequest("GET", "/json/version"); return; } catch {}
    chromiumProc.kill("SIGKILL");
    chromiumProc = null;
  }
  if (starting) { await starting; return; }
  starting = (async () => {
    try {
      // Clean stale lock files from previous runs
      const fs = await import("fs");
      for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
        const p = resolve(PROFILE_DIR, lock);
        try { fs.unlinkSync(p); } catch {}
      }

      chromiumProc = spawn(CHROMIUM_PATH, [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--single-process",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--window-size=1280,720",
        "--start-maximized",
        `--remote-debugging-port=${CDP_PORT}`,
        "--remote-debugging-address=0.0.0.0",
        `--user-data-dir=${PROFILE_DIR}`,
        "--disable-dbus-activation",
        "--disable-breakpad",
        "--disable-background-networking",
        "--disable-component-extensions-with-background-pages",
        "--disable-default-apps",
        "--disable-notifications",
        "--disable-sync",
        "--disable-popup-blocking",
        "--no-first-run",
        "--metrics-recording-only",
        "about:blank",
      ], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          DBUS_SESSION_BUS_ADDRESS: "/dev/null",
          GNOME_DISABLE_CRASH_DIALOG: "1",
        },
      });

      const spawnErrorRef: { err: Error | null } = { err: null };
      chromiumProc.on("error", (err: Error) => {
        spawnErrorRef.err = err;
        console.error(`[chromium] Failed to spawn: ${err.message}`);
        chromiumProc = null;
      });

      chromiumProc.stdout?.on("data", (d: Buffer) => {
        const line = d.toString();
        if (!shouldSuppress(line)) process.stdout.write(`[chromium] ${d}`);
      });
      chromiumProc.stderr?.on("data", (d: Buffer) => {
        const line = d.toString();
        if (!shouldSuppress(line)) process.stderr.write(`[chromium] ${d}`);
      });
      chromiumProc.on("exit", (code) => {
        console.log(`[chromium] exited ${code}`);
        chromiumProc = null;
      });

      await sleep(100);
      if (spawnErrorRef.err) {
        throw new Error(`Chromium spawn failed: ${spawnErrorRef.err.message}`);
      }

      await waitForCdp();
      console.log("[slack] Chromium started with CDP on port " + CDP_PORT);
    } finally {
      starting = null;
    }
  })();
  await starting;
}

export async function killChromium(): Promise<void> {
  if (chromiumProc) {
    const proc = chromiumProc;
    proc.kill("SIGTERM");
    await sleep(500);
    if (!proc.killed) proc.kill("SIGKILL");
    chromiumProc = null;
  }
}

export async function cdpNewTab(url?: string): Promise<any> {
  const path = url ? `/json/new?${url}` : "/json/new?about:blank";
  try {
    const tab = await cdpRequest("PUT", path);
    if (tab && tab.webSocketDebuggerUrl) return tab;
  } catch {}
  const tabs = await cdpRequest("GET", "/json/list");
  if (Array.isArray(tabs) && tabs.length > 0) return tabs[0];
  throw new Error("Failed to create new tab");
}

export async function cdpCloseTab(id: string): Promise<void> {
  await cdpRequest("GET", `/json/close/${id}`).catch(() => {});
}

export async function cdpListTabs(): Promise<any[]> {
  const result = await cdpRequest("GET", "/json/list");
  return Array.isArray(result) ? result : [];
}

export async function createSlackLoginScreencast(): Promise<{ webSocketDebuggerUrl: string; id: string }> {
  await ensureChromium();

  // Close any non-blank tabs first
  const existing = await cdpListTabs();
  for (const p of existing) {
    if (p.url !== "about:blank") {
      await cdpCloseTab(p.id);
    }
  }

  const tab = await cdpNewTab();
  if (!tab.webSocketDebuggerUrl) {
    throw new Error("No webSocketDebuggerUrl for new tab");
  }

  // Navigate to Slack login
  const { WebSocket: NodeWebSocket } = await import("ws");
  await new Promise<void>((resolve) => {
    const ws = new NodeWebSocket(tab.webSocketDebuggerUrl);
    ws.on("open", () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Page.navigate",
        params: { url: "https://slack.com/signin" }
      }));
      setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 1500);
    });
    ws.on("error", () => resolve());
    setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 5000);
  });

  await sleep(1000);
  return { webSocketDebuggerUrl: tab.webSocketDebuggerUrl, id: tab.id };
}

export { CDP_PORT };
