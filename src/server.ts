/**
 * Slack ingestor server — Express + WebSocket for browser-driven session capture,
 * plus the Sync UI with scheduler for automated message ingestion.
 */
import "dotenv/config";
import { createServer, type IncomingMessage } from "http";
import { type Socket } from "net";
import express from "express";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import path from "path";
import { fileURLToPath } from "url";
import {
  ensureChromium,
  createSlackLoginScreencast,
  cdpListTabs,
  cdpCloseTab,
} from "./lib/browser.js";
import { setCookies, saveSessionToFile, loadSessionFromFile, hasSession, isAuthCookie } from "./lib/session.js";
import { validateSession, listChannels } from "./lib/slack-api.js";
import syncRouter from "./lib/sync-router.js";
import { startScheduler } from "./lib/scheduler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.LOGIN_SERVER_PORT || process.env.PORT || "3101");

const wss = new WebSocketServer({ noServer: true });

const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

type SessionStatus = "idle" | "running" | "success" | "timeout" | "error";

interface LoginSession {
  tabId: string;
  webSocketDebuggerUrl: string;
  status: SessionStatus;
  message: string;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

let session: LoginSession | null = null;

function closeSession() {
  if (!session) return;
  const s = session;
  session = null;
  clearTimeout(s.timeoutHandle);
  cdpListTabs()
    .then((tabs) => {
      for (const tab of tabs) {
        if (tab.id === s.tabId) {
          cdpCloseTab(tab.id).catch(() => {});
        }
      }
    })
    .catch(() => {});
}

// Special key mapping
const SPECIAL_KEY_MAP: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter:     { code: "Enter",     keyCode: 13, text: "\r" },
  Backspace: { code: "Backspace", keyCode: 8 },
  Tab:       { code: "Tab",       keyCode: 9 },
  Escape:    { code: "Escape",    keyCode: 27 },
  Delete:    { code: "Delete",    keyCode: 46 },
  ArrowUp:   { code: "ArrowUp",   keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight:{ code: "ArrowRight",keyCode: 39 },
  Home:      { code: "Home",      keyCode: 36 },
  End:       { code: "End",       keyCode: 35 },
  PageUp:    { code: "Prior",     keyCode: 33 },
  PageDown:  { code: "Next",      keyCode: 34 },
};

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());

// ── Routes ────────────────────────────────────────────────────────────────────

// Root — info endpoint
app.get("/", (_req, res) => {
  res.json({
    name: "openclaw-slack-ingestor",
    version: "0.3.0",
    endpoints: {
      login: "/login",
      loginStatus: "/api/login/status",
      syncUi: "/sync",
      syncApi: "/api/sync",
      jobs: "/api/jobs",
      runs: "/api/runs",
      sessionStatus: "/api/session/status",
      schedulerStatus: "/api/scheduler/status",
    },
  });
});

// Health check
app.get("/api/health", async (_req, res) => {
  const validation = hasSession() ? await validateSession() : { valid: false };
  res.json({
    status: "ok",
    authenticated: validation.valid,
    team: (validation as { team?: string }).team,
    user: (validation as { user?: string }).user,
  });
});

// List channels
app.get("/api/channels", async (_req, res) => {
  if (!hasSession()) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  const result = await listChannels();
  res.json(result);
});

// Remote login UI
app.get("/login", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(LOGIN_HTML);
});

// Start login session
app.post("/api/login/start", async (_req, res) => {
  if (session && session.status === "running") {
    return res.status(409).json({ error: "Session already running" });
  }

  closeSession();

  try {
    console.log("[login] Starting Chromium...");
    const tabInfo = await createSlackLoginScreencast();

    const timeoutHandle = setTimeout(() => {
      if (session && session.status === "running") {
        console.log("[login] Session timed out.");
        session.status = "timeout";
        session.message = "⏰ Session timed out after 5 minutes.";
        closeSession();
      }
    }, SESSION_TIMEOUT_MS);

    session = {
      tabId: tabInfo.id,
      webSocketDebuggerUrl: tabInfo.webSocketDebuggerUrl,
      status: "running",
      message: "Browser started. Please log in to Slack.",
      startedAt: Date.now(),
      timeoutHandle,
    };

    console.log("[login] Session started, tab:", tabInfo.id);
    res.json({ success: true, message: "Browser session started." });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[login] Failed to start:", message);
    res.status(500).json({ error: message });
  }
});

// Login status
app.get("/api/login/status", (_req, res) => {
  if (!session) {
    return res.json({ status: "idle", message: "No session active." });
  }
  const remainingMs = SESSION_TIMEOUT_MS - (Date.now() - session.startedAt);
  res.json({
    status: session.status,
    message: session.message,
    remainingMs: Math.max(0, remainingMs),
  });
});

// Stop login
app.post("/api/login/stop", (_req, res) => {
  closeSession();
  res.json({ success: true });
});

// Logout (clear session)
app.post("/api/logout", async (_req, res) => {
  const { clearSession: clear } = await import("./lib/session.js");
  clear();
  res.json({ success: true });
});

// ── Mount sync router (UI + API) ──────────────────────────────────────────────

app.use(syncRouter);

// ── WebSocket Handler ────────────────────────────────────────────────────────

export function handleLoginWs(req: IncomingMessage, socket: Socket, head: Buffer) {
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    if (!session || session.status !== "running") {
      clientWs.close(1008, "No active login session");
      return;
    }

    const cdpWsUrl = session.webSocketDebuggerUrl;
    const cdpWs = new NodeWebSocket(cdpWsUrl);
    let cmdId = 1;
    const capturedCookies: Record<string, string> = {};
    let loginDetected = false;

    function cdpCommand(method: string, params: Record<string, unknown> = {}) {
      const id = cmdId++;
      if (cdpWs.readyState === NodeWebSocket.OPEN) {
        cdpWs.send(JSON.stringify({ method, params, id }));
      }
      return id;
    }

    async function checkAndCapture() {
      if (capturedCookies["d"] && session && !loginDetected) {
        loginDetected = true;
        console.log("[login] Auth cookies captured!");
        setCookies(capturedCookies);

        const validation = await validateSession();

        if (validation.valid) {
          await saveSessionToFile();
          session.status = "success";
          session.message = `✅ Logged in as ${validation.user} (${validation.team})`;
          if (clientWs.readyState === NodeWebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: "success", user: validation.user, team: validation.team }));
          }
          setTimeout(() => closeSession(), 4000);
        } else {
          loginDetected = false;
          console.log("[login] Session captured but validation failed:", validation.error);
        }
      }
    }

    cdpWs.on("open", () => {
      cdpCommand("Page.enable");
      cdpCommand("Network.enable");
      cdpCommand("Page.startScreencast", {
        format: "jpeg",
        quality: 85,
        maxWidth: VIEWPORT_WIDTH,
        maxHeight: VIEWPORT_HEIGHT,
      });
    });

    cdpWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          method?: string;
          params?: Record<string, unknown>;
        };

        if (msg.method === "Page.screencastFrame") {
          const params = msg.params as { sessionId: number; data: string; metadata: unknown };
          if (clientWs.readyState === NodeWebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: "frame", data: params.data, metadata: params.metadata }));
          }
          cdpCommand("Page.screencastFrameAck", { sessionId: params.sessionId });
        } else if (msg.method === "Network.responseReceivedExtraInfo") {
          const headers = (msg.params as { headers?: Record<string, string> }).headers || {};
          for (const [name, value] of Object.entries(headers)) {
            if (name.toLowerCase() !== "set-cookie") continue;
            const entries = String(value).split("\n");
            for (const entry of entries) {
              const match = entry.match(/^([a-zA-Z0-9_-]+)=([^;]+)/);
              if (match && isAuthCookie(match[1])) {
                capturedCookies[match[1]] = match[2];
                console.log(`[login] Captured ${match[1]} from Set-Cookie`);
              }
            }
          }
          checkAndCapture();
        } else if (msg.method === "Network.requestWillBeSentExtraInfo") {
          const params = msg.params as {
            associatedCookies?: Array<{ cookie: { name: string; value: string } }>;
            headers?: Record<string, string>;
          };
          if (Array.isArray(params.associatedCookies)) {
            for (const entry of params.associatedCookies) {
              const c = entry.cookie;
              if (c?.name && c.value && isAuthCookie(c.name)) {
                capturedCookies[c.name] = c.value;
              }
            }
          }
          const h = params.headers?.["cookie"] || params.headers?.["Cookie"];
          if (h) {
            for (const pair of h.split(";")) {
              const idx = pair.indexOf("=");
              if (idx > 0) {
                const name = pair.slice(0, idx).trim();
                const val = pair.slice(idx + 1).trim();
                if (isAuthCookie(name) && val) capturedCookies[name] = val;
              }
            }
          }
          checkAndCapture();
        } else if (msg.method === "Page.frameNavigated") {
          const url = (msg.params as { frame?: { url?: string } })?.frame?.url || "";
          if (url.includes(".slack.com/archives") || url.includes("app.slack.com/client")) {
            setTimeout(() => checkAndCapture(), 2000);
          }
        }
      } catch {}
    });

    clientWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { type: string; x?: number; y?: number; key?: string; text?: string };

        if (msg.type === "click") {
          const { x, y } = msg;
          cdpCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          setTimeout(() => {
            cdpCommand("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
            setTimeout(() => {
              cdpCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
            }, 50);
          }, 30);
        } else if (msg.type === "keydown") {
          const key = msg.key as string;
          const keyInfo = SPECIAL_KEY_MAP[key];
          if (keyInfo) {
            cdpCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: keyInfo.code, windowsVirtualKeyCode: keyInfo.keyCode });
            if (keyInfo.text) cdpCommand("Input.dispatchKeyEvent", { type: "char", text: keyInfo.text });
            cdpCommand("Input.dispatchKeyEvent", { type: "keyUp", key, code: keyInfo.code, windowsVirtualKeyCode: keyInfo.keyCode });
          } else {
            cdpCommand("Input.dispatchKeyEvent", { type: "keyDown", key, text: key });
            cdpCommand("Input.dispatchKeyEvent", { type: "keyUp", key });
          }
        } else if (msg.type === "type") {
          cdpCommand("Input.insertText", { text: msg.text });
        }
      } catch {}
    });

    const cleanup = () => {
      try { cdpCommand("Page.stopScreencast"); } catch {}
      try { cdpWs.close(); } catch {}
      try { clientWs.close(); } catch {}
    };

    clientWs.on("close", cleanup);
    cdpWs.on("close", () => { try { clientWs.close(); } catch {} });
    cdpWs.on("error", (err) => {
      console.error("[login] CDP WS error:", err.message);
      try { clientWs.close(); } catch {}
    });
    clientWs.on("error", () => cleanup());
  });
}

// ── HTML UI ──────────────────────────────────────────────────────────────────

const LOGIN_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Slack Login — OpenClaw</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f0f0f;color:#e0e0e0;font-family:system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:16px 8px}
  h1{font-size:1.4rem;font-weight:600;margin-bottom:12px;color:#fff}
  #status-bar{
    width:100%;max-width:900px;
    background:#1a1a2e;border:1px solid #333;border-radius:8px;
    padding:10px 16px;margin-bottom:12px;font-size:.9rem;min-height:42px;
    display:flex;align-items:center;gap:8px;
  }
  #status-dot{width:10px;height:10px;border-radius:50%;background:#555;flex-shrink:0;transition:background .3s}
  #status-dot.running{background:#22c55e;animation:pulse 1.2s infinite}
  #status-dot.success{background:#22c55e}
  #status-dot.timeout,#status-dot.error{background:#ef4444}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  #timer{margin-left:auto;font-size:.8rem;color:#888;white-space:nowrap}
  .controls{width:100%;max-width:900px;display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;align-items:center;}
  button{background:#4A154B;color:#fff;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:.85rem;font-weight:500;transition:background .15s;white-space:nowrap;}
  button:hover{background:#611f69}
  button:disabled{background:#374151;cursor:not-allowed;color:#6b7280}
  button.danger{background:#dc2626}
  button.danger:hover{background:#b91c1c}
  button.secondary{background:#374151}
  button.secondary:hover{background:#4b5563}
  #type-input{flex:1;min-width:180px;background:#1e1e1e;border:1px solid #444;color:#e0e0e0;border-radius:6px;padding:8px 12px;font-size:.85rem;}
  #type-input:focus{outline:none;border-color:#4A154B}
  .key-group{display:flex;gap:4px}
  #canvas-wrap{width:100%;max-width:900px;position:relative;background:#111;border:2px solid #333;border-radius:8px;overflow:hidden;cursor:pointer;outline:none;transition:border-color .2s;}
  #canvas-wrap.inactive{cursor:default;pointer-events:none}
  #canvas-wrap.canvas-focused{border-color:#4A154B;box-shadow:0 0 0 2px rgba(74,21,75,.3)}
  #screen{display:block;width:100%;height:auto;user-select:none;}
  #placeholder{width:100%;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;color:#555;font-size:1rem;}
  #overlay-msg{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.7);font-size:1.3rem;font-weight:600;color:#fff;}
  .nav-links{display:flex;gap:16px;margin-top:12px;font-size:.85rem}
  .nav-links a{color:#9c27b0;text-decoration:none}
  .nav-links a:hover{text-decoration:underline}
</style>
</head>
<body>
<h1>🔐 Slack Login</h1>

<div id="status-bar">
  <span id="status-dot"></span>
  <span id="status-text">Click "Start Login" to connect to Slack.</span>
  <span id="timer"></span>
</div>

<div class="controls">
  <button id="start-btn" onclick="startSession()">▶ Start Login</button>
  <button id="stop-btn" class="danger" onclick="stopSession()" disabled>■ Stop</button>
  <input id="type-input" type="text" placeholder="Type text and press Enter..." onkeydown="onInputKey(event)"/>
  <div class="key-group">
    <button class="secondary" onclick="sendKey('Enter')" disabled id="key-enter">↵ Enter</button>
    <button class="secondary" onclick="sendKey('Tab')" disabled id="key-tab">⇥ Tab</button>
    <button class="secondary" onclick="sendKey('Backspace')" disabled id="key-bs">⌫ Back</button>
  </div>
</div>

<div id="canvas-wrap" class="inactive" tabindex="0">
  <canvas id="screen"></canvas>
  <div id="placeholder">Login screen will appear here.</div>
  <div id="overlay-msg"></div>
</div>

<div class="nav-links">
  <a href="/sync">→ Sync UI</a>
  <a href="/api/session/status">→ Session Status</a>
</div>

<script>
const BASE = '/api';
let ws = null;
let sessionActive = false;
let startTime = null;
let timerInterval = null;
let hasFirstFrame = false;

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const placeholder = document.getElementById('placeholder');
const canvasWrap = document.getElementById('canvas-wrap');

canvas.width = ${VIEWPORT_WIDTH};
canvas.height = ${VIEWPORT_HEIGHT};

function setStatus(text, dotClass) {
  document.getElementById('status-text').textContent = text;
  document.getElementById('status-dot').className = dotClass || '';
}

function setControlsEnabled(enabled) {
  sessionActive = enabled;
  document.getElementById('stop-btn').disabled = !enabled;
  ['key-enter','key-tab','key-bs'].forEach(id => { document.getElementById(id).disabled = !enabled; });
  canvasWrap.classList.toggle('inactive', !enabled);
}

function startTimer() {
  startTime = Date.now();
  timerInterval = setInterval(() => {
    if (!startTime) return;
    const elapsed = Date.now() - startTime;
    const remaining = Math.max(0, 300000 - elapsed);
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    document.getElementById('timer').textContent = remaining > 0 ? \`⏱ \${m}:\${s.toString().padStart(2,'0')} left\` : '';
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  document.getElementById('timer').textContent = '';
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws/login');
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'frame') {
        const img = new Image();
        img.onload = () => {
          if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) {
            canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
          }
          ctx.drawImage(img, 0, 0);
          if (!hasFirstFrame) {
            hasFirstFrame = true;
            placeholder.style.display = 'none';
            canvas.style.display = 'block';
          }
        };
        img.src = 'data:image/jpeg;base64,' + msg.data;
      } else if (msg.type === 'success') {
        stopTimer();
        setStatus('✅ Logged in as ' + msg.user + ' (' + msg.team + ')', 'success');
        setControlsEnabled(false);
        showOverlay('✅ Login successful! Redirecting...');
        document.getElementById('start-btn').disabled = false;
        if (ws) { try { ws.close(); } catch {} ws = null; }
        setTimeout(() => { window.location.href = '/sync'; }, 3000);
      }
    } catch(e) {}
  };
}

async function startSession() {
  document.getElementById('start-btn').disabled = true;
  hasFirstFrame = false;
  canvas.style.display = 'none';
  placeholder.style.display = 'flex';
  placeholder.textContent = 'Starting browser...';
  setStatus('Starting browser...', 'running');
  try {
    const r = await fetch(BASE + '/login/start', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to start');
    setStatus('Browser started. Log in to Slack.', 'running');
    setControlsEnabled(true);
    startTimer();
    setTimeout(connectWs, 500);
  } catch(e) {
    setStatus('Error: ' + e.message, 'error');
    document.getElementById('start-btn').disabled = false;
    placeholder.textContent = 'Failed to start.';
  }
}

async function stopSession() {
  stopTimer();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  await fetch(BASE + '/login/stop', { method: 'POST' }).catch(() => {});
  setControlsEnabled(false);
  setStatus('Session stopped.', '');
  document.getElementById('start-btn').disabled = false;
  hasFirstFrame = false;
  canvas.style.display = 'none';
  placeholder.style.display = 'flex';
  placeholder.textContent = 'Session stopped.';
}

function showOverlay(msg) {
  const o = document.getElementById('overlay-msg');
  o.textContent = msg; o.style.display = 'flex';
}

canvasWrap.addEventListener('click', (event) => {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  const rect = canvas.getBoundingClientRect();
  const relX = (event.clientX - rect.left) / rect.width;
  const relY = (event.clientY - rect.top) / rect.height;
  ws.send(JSON.stringify({ type: 'click', x: Math.round(relX * canvas.width), y: Math.round(relY * canvas.height) }));
});

document.addEventListener('keydown', (event) => {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (document.activeElement === document.getElementById('type-input')) return;
  event.preventDefault();
  if (event.key.length === 1) ws.send(JSON.stringify({ type: 'type', text: event.key }));
  else ws.send(JSON.stringify({ type: 'keydown', key: event.key }));
});

function onInputKey(event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    const input = document.getElementById('type-input');
    const text = input.value;
    if (text && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'type', text }));
      input.value = '';
    }
  }
}

function sendKey(key) {
  if (!sessionActive || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'keydown', key }));
}
</script>
</body>
</html>`;

// ── Start Server ─────────────────────────────────────────────────────────────

async function main() {
  // Load persisted session
  const loaded = await loadSessionFromFile();
  if (loaded) {
    console.log("[startup] Slack session loaded from file");
  } else {
    console.log("[startup] No Slack session — use /login to authenticate");
  }

  const httpServer = createServer(app);

  // WebSocket upgrade
  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url || "";
    if (url === "/ws/login") {
      handleLoginWs(req, socket as Socket, head);
    } else {
      socket.destroy();
    }
  });

  httpServer.listen(PORT, async () => {
    console.log(`[Slack Ingestor] Running on http://localhost:${PORT}`);
    console.log(`[Slack Ingestor] Login UI:  http://localhost:${PORT}/login`);
    console.log(`[Slack Ingestor] Sync UI:   http://localhost:${PORT}/sync`);

    // Start the job scheduler after server is listening
    await startScheduler();
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
