import { Router, Request, Response, NextFunction } from 'express';
import {
  backfillAttachments,
  BackfillProgress,
  BackfillOptions,
  BackfillMode,
} from '../commands/backfill-attachments.js';
import {
  loadBackfillRuns,
  createBackfillRun,
  updateBackfillRun,
  getBackfillRun,
  getRecentBackfillRuns,
  getActiveBackfillRun,
} from './backfill-store.js';

const router = Router();

// Track active runs and their progress
const activeRuns = new Map<string, { progress: BackfillProgress }>();

// Track SSE clients for each run
const sseClients = new Map<string, Set<Response>>();

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const uiToken = process.env.UI_TOKEN;
  if (!uiToken) { next(); return; }

  const authHeader = req.headers['authorization'];
  const bearer = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const queryToken = typeof req.query.token === 'string' ? req.query.token : undefined;
  const provided = bearer ?? queryToken;

  if (!provided || provided !== uiToken) {
    res.status(401).json({ error: 'Unauthorized: invalid or missing UI_TOKEN.' });
    return;
  }
  next();
}

// ── UI Page ────────────────────────────────────────────────────────────────────

router.get('/backfill', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildBackfillUI(Boolean(process.env.UI_TOKEN)));
});

// ── API: Start backfill ────────────────────────────────────────────────────────

router.post('/api/backfill/start', requireAuth, async (req: Request, res: Response) => {
  const {
    batchSize = 5,
    limit,
    dryRun = false,
    resumeFrom = 1,
    mode = 'slack-api',
  } = req.body as {
    batchSize?: number;
    limit?: number;
    dryRun?: boolean;
    resumeFrom?: number;
    mode?: BackfillMode;
  };

  const existingActive = await getActiveBackfillRun();
  if (existingActive) {
    res.status(409).json({ error: 'A backfill is already running.', runId: existingActive.runId });
    return;
  }

  const options: BackfillOptions = {
    batchSize: Math.max(1, batchSize),
    limit,
    dryRun,
    resumeFrom: Math.max(1, resumeFrom),
    mode: mode === 'memory-db' ? 'memory-db' : 'slack-api',
  };

  try {
    const run = await createBackfillRun(options, options.mode);

    activeRuns.set(run.runId, {
      progress: {
        runId: run.runId,
        page: resumeFrom,
        totalPages: 0,
        messagesProcessed: 0,
        downloadedCount: 0,
        ingestedCount: 0,
        skippedCount: 0,
        errorCount: 0,
        startTime: new Date(),
        currentTime: new Date(),
      },
    });
    sseClients.set(run.runId, new Set());

    res.json({
      runId: run.runId,
      status: 'running',
      startedAt: run.startedAt,
      progress: activeRuns.get(run.runId)?.progress,
    });

    // Run in background
    backfillAttachments(options, (progress) => {
      activeRuns.set(run.runId, { progress });
      const clients = sseClients.get(run.runId);
      if (clients) {
        const msg = 'data: ' + JSON.stringify(progress) + '\n\n';
        clients.forEach(c => c.write(msg));
      }
    })
      .then(async (stats) => {
        await updateBackfillRun(run.runId, {
          status: 'complete',
          completedAt: new Date().toISOString(),
          stats: {
            totalMessages: stats.messagesProcessed,
            messagesWithAttachments: stats.messagesWithAttachments,
            downloadedAttachments: stats.attachmentsDownloaded,
            ingestedAttachments: stats.attachmentsIngested,
            skipped: stats.attachmentsSkipped,
            errors: stats.errors.length,
          },
        });
        const clients = sseClients.get(run.runId);
        if (clients) {
          const msg = 'event: complete\ndata: ' + JSON.stringify({ runId: run.runId, status: 'complete' }) + '\n\n';
          clients.forEach(c => { c.write(msg); c.end(); });
          sseClients.delete(run.runId);
        }
        activeRuns.delete(run.runId);
      })
      .catch(async (err) => {
        console.error(`[backfill] Error in run ${run.runId}:`, err);
        await updateBackfillRun(run.runId, {
          status: 'error',
          completedAt: new Date().toISOString(),
          error: err.message || String(err),
        });
        const clients = sseClients.get(run.runId);
        if (clients) {
          const msg = 'event: error\ndata: ' + JSON.stringify({ runId: run.runId, status: 'error', message: err.message || String(err) }) + '\n\n';
          clients.forEach(c => { c.write(msg); c.end(); });
          sseClients.delete(run.runId);
        }
        activeRuns.delete(run.runId);
      });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Get status ────────────────────────────────────────────────────────────

router.get('/api/backfill/status', requireAuth, async (_req: Request, res: Response) => {
  const activeRun = await getActiveBackfillRun();
  if (!activeRun) {
    res.json({ status: 'idle' });
    return;
  }
  const activeData = activeRuns.get(activeRun.runId);
  res.json({
    runId: activeRun.runId,
    status: activeRun.status,
    startedAt: activeRun.startedAt,
    paused: activeRun.paused,
    progress: activeData?.progress || null,
  });
});

// ── API: SSE events ────────────────────────────────────────────────────────────

router.get('/api/backfill/events/:runId', requireAuth, (req: Request, res: Response) => {
  const runId = String(req.params.runId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (!sseClients.has(runId)) sseClients.set(runId, new Set());
  const clients = sseClients.get(runId)!;
  clients.add(res);

  const activeData = activeRuns.get(runId);
  if (activeData?.progress) {
    res.write('data: ' + JSON.stringify(activeData.progress) + '\n\n');
  }

  req.on('close', () => {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(runId);
  });
});

// ── API: Pause ────────────────────────────────────────────────────────────────

router.post('/api/backfill/pause', requireAuth, async (req: Request, res: Response) => {
  const { runId } = req.body as { runId?: string };
  if (!runId) { res.status(400).json({ error: 'runId is required.' }); return; }

  const run = await getBackfillRun(runId);
  if (!run) { res.status(404).json({ error: 'Run not found.' }); return; }
  if (run.status !== 'running') { res.status(400).json({ error: 'Run is not running.' }); return; }

  const activeData = activeRuns.get(runId);
  const currentPage = activeData?.progress.page ?? run.lastPage;

  await updateBackfillRun(runId, { paused: true, pausedAt: new Date().toISOString(), lastPage: currentPage });
  res.json({ runId, status: 'paused', lastPage: currentPage });
});

// ── API: Resume ────────────────────────────────────────────────────────────────

router.post('/api/backfill/resume', requireAuth, async (req: Request, res: Response) => {
  const { runId } = req.body as { runId?: string };
  if (!runId) { res.status(400).json({ error: 'runId is required.' }); return; }

  const run = await getBackfillRun(runId);
  if (!run) { res.status(404).json({ error: 'Run not found.' }); return; }
  if (!run.paused) { res.status(400).json({ error: 'Run is not paused.' }); return; }

  const existingActive = await getActiveBackfillRun();
  if (existingActive && existingActive.runId !== runId) {
    res.status(409).json({ error: 'Another backfill is already running.' });
    return;
  }

  await updateBackfillRun(runId, { paused: false, pausedAt: undefined, status: 'running' });

  activeRuns.set(runId, {
    progress: {
      runId,
      page: run.lastPage,
      totalPages: run.totalPages,
      messagesProcessed: run.stats.totalMessages,
      downloadedCount: run.stats.downloadedAttachments,
      ingestedCount: run.stats.ingestedAttachments,
      skippedCount: run.stats.skipped,
      errorCount: run.stats.errors,
      startTime: new Date(),
      currentTime: new Date(),
    },
  });
  sseClients.set(runId, new Set());

  res.json({ runId, status: 'running', lastPage: run.lastPage });

  backfillAttachments({ ...run.options, resumeFrom: run.lastPage, mode: run.mode }, (progress) => {
    activeRuns.set(runId, { progress });
    const clients = sseClients.get(runId);
    if (clients) {
      const msg = 'data: ' + JSON.stringify(progress) + '\n\n';
      clients.forEach(c => c.write(msg));
    }
  })
    .then(async (stats) => {
      await updateBackfillRun(runId, {
        status: 'complete',
        completedAt: new Date().toISOString(),
        stats: {
          totalMessages: stats.messagesProcessed,
          messagesWithAttachments: stats.messagesWithAttachments,
          downloadedAttachments: stats.attachmentsDownloaded,
          ingestedAttachments: stats.attachmentsIngested,
          skipped: stats.attachmentsSkipped,
          errors: stats.errors.length,
        },
      });
      const clients = sseClients.get(runId);
      if (clients) {
        const msg = 'event: complete\ndata: ' + JSON.stringify({ runId, status: 'complete' }) + '\n\n';
        clients.forEach(c => { c.write(msg); c.end(); });
        sseClients.delete(runId);
      }
      activeRuns.delete(runId);
    })
    .catch(async (err) => {
      await updateBackfillRun(runId, { status: 'error', completedAt: new Date().toISOString(), error: err.message });
      const clients = sseClients.get(runId);
      if (clients) {
        const msg = 'event: error\ndata: ' + JSON.stringify({ runId, status: 'error', message: err.message }) + '\n\n';
        clients.forEach(c => { c.write(msg); c.end(); });
        sseClients.delete(runId);
      }
      activeRuns.delete(runId);
    });
});

// ── API: List runs ────────────────────────────────────────────────────────────

router.get('/api/backfill/runs', requireAuth, async (_req: Request, res: Response) => {
  const runs = await getRecentBackfillRuns(50);
  res.json({
    runs: runs.map(run => ({
      runId: run.runId,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      status: run.status,
      mode: run.mode,
      stats: run.stats,
    })),
  });
});

// ── HTML UI ────────────────────────────────────────────────────────────────────

function buildBackfillUI(requiresAuth: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Slack Ingestor — Attachment Backfill</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #f9fafb; color: #111827; margin: 0; padding: 20px; line-height: 1.6;
    }
    .container {
      max-width: 1200px; margin: 0 auto; background: white;
      border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.1); padding: 24px;
    }
    h1 { margin: 0 0 24px; font-size: 1.875rem; color: #1f2937; }
    .auth-modal {
      position: fixed; inset: 0; background: rgba(0,0,0,.5);
      display: none; align-items: center; justify-content: center; z-index: 1000;
    }
    .auth-modal.active { display: flex; }
    .auth-modal-content { background: white; padding: 24px; border-radius: 8px; text-align: center; }
    .auth-modal input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #d1d5db; border-radius: 4px; font-size: 1rem; }
    .auth-modal button { background: #4A154B; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 1rem; }
    .control-panel { background: #f3f4f6; padding: 16px; border-radius: 6px; margin-bottom: 24px; }
    .control-row { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 16px; margin-bottom: 16px; }
    @media (max-width: 900px) { .control-row { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 500px) { .control-row { grid-template-columns: 1fr; } }
    .control-group { display: flex; flex-direction: column; }
    label { font-weight: 600; font-size: .875rem; color: #374151; margin-bottom: 6px; }
    input[type="number"], select { padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px; font-size: .95rem; background: white; }
    .checkbox-group { display: flex; align-items: center; gap: 6px; }
    .checkbox-group label { margin: 0; }
    .button-group { display: flex; gap: 8px; margin-top: 16px; }
    button { padding: 10px 16px; border: none; border-radius: 4px; font-weight: 600; font-size: .95rem; cursor: pointer; transition: all .2s; }
    .btn-primary { background: #4A154B; color: white; }
    .btn-primary:hover { background: #611f69; }
    .btn-primary:disabled { background: #9ca3af; cursor: not-allowed; }
    .btn-secondary { background: #6b7280; color: white; }
    .btn-secondary:hover { background: #4b5563; }
    .btn-secondary:disabled { background: #d1d5db; cursor: not-allowed; }
    .status-section { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 16px; border-radius: 6px; margin-bottom: 24px; }
    .status-section.error { background: #fef2f2; border-color: #fecaca; }
    .status-label { font-weight: 700; font-size: .875rem; color: #374151; }
    .status-value { font-size: 1.25rem; margin-top: 6px; font-weight: 600; }
    .progress-container { margin-bottom: 24px; }
    .progress-bar { width: 100%; height: 24px; background: #e5e7eb; border-radius: 4px; overflow: hidden; margin-bottom: 12px; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, #4A154B, #611f69); transition: width .3s ease; display: flex; align-items: center; justify-content: center; color: white; font-weight: 600; font-size: .75rem; }
    .progress-stats { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 12px; }
    @media (max-width: 700px) { .progress-stats { grid-template-columns: 1fr 1fr; } }
    .stat-box { background: #f9fafb; border: 1px solid #e5e7eb; padding: 12px; border-radius: 4px; text-align: center; }
    .stat-label { font-size: .75rem; color: #6b7280; font-weight: 600; text-transform: uppercase; margin-bottom: 4px; }
    .stat-value { font-size: 1.5rem; font-weight: 700; color: #1f2937; }
    .events-section { margin-bottom: 24px; }
    .events-header { font-weight: 700; font-size: 1rem; margin-bottom: 12px; color: #1f2937; }
    .events-list { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 4px; max-height: 300px; overflow-y: auto; font-family: monospace; font-size: .8rem; }
    .event-item { padding: 8px 12px; border-bottom: 1px solid #e5e7eb; color: #4b5563; display: flex; gap: 12px; }
    .event-item:last-child { border-bottom: none; }
    .event-time { color: #9ca3af; white-space: nowrap; min-width: 70px; }
    .event-text { word-break: break-word; }
    .runs-section { margin-top: 32px; }
    .runs-header { font-weight: 700; font-size: 1rem; margin-bottom: 12px; color: #1f2937; }
    table { width: 100%; border-collapse: collapse; font-size: .9rem; }
    thead { background: #f3f4f6; border-bottom: 2px solid #e5e7eb; }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
    th { font-weight: 600; color: #374151; }
    tbody tr:hover { background: #f9fafb; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-weight: 600; font-size: .75rem; }
    .badge-complete { background: #d1fae5; color: #065f46; }
    .badge-running { background: #dbeafe; color: #1e40af; }
    .badge-error { background: #fee2e2; color: #991b1b; }
    .badge-paused { background: #fef3c7; color: #92400e; }
  </style>
</head>
<body>
  <div class="auth-modal" id="authModal">
    <div class="auth-modal-content">
      <h2>Authentication Required</h2>
      <input type="password" id="tokenInput" placeholder="Enter UI_TOKEN" />
      <button onclick="submitToken()">Submit</button>
    </div>
  </div>

  <div class="container">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
      <h1 style="margin:0">📥 Slack — Attachment Backfill</h1>
      <a href="/sync" style="color:#4A154B;font-size:.85rem;text-decoration:none;padding:6px 12px;border-radius:6px;border:1px solid #4A154B">← Back to Sync</a>
    </div>

    <div id="statusSection" class="status-section" style="display:none">
      <div class="status-label">STATUS</div>
      <div class="status-value" id="statusValue">Idle</div>
    </div>

    <div class="control-panel">
      <div class="control-row">
        <div class="control-group">
          <label for="modeSelect">Mode</label>
          <select id="modeSelect">
            <option value="slack-api" selected>From Slack API (preferred — fresh URLs)</option>
            <option value="memory-db">From Memory DB (uses stored URLs)</option>
          </select>
        </div>
        <div class="control-group">
          <label for="batchSize">Batch Size</label>
          <input type="number" id="batchSize" value="5" min="1" max="20">
          <small style="color:#6b7280">Concurrent downloads</small>
        </div>
        <div class="control-group">
          <label for="limit">Limit</label>
          <input type="number" id="limit" placeholder="blank = all">
          <small style="color:#6b7280">Max messages to process</small>
        </div>
        <div class="control-group" id="resumeFromGroup">
          <label for="resumeFrom">Resume From Page</label>
          <input type="number" id="resumeFrom" value="1" min="1">
          <small style="color:#6b7280">Memory DB mode only</small>
        </div>
      </div>
      <div class="checkbox-group">
        <input type="checkbox" id="dryRun">
        <label for="dryRun">Dry Run (download only, don't ingest)</label>
      </div>
      <div class="button-group">
        <button id="startBtn" class="btn-primary" onclick="startBackfill()">▶ Start Backfill</button>
        <button id="pauseBtn" class="btn-secondary" onclick="pauseBackfill()" disabled>❚❚ Pause</button>
        <button id="resumeBtn" class="btn-secondary" onclick="resumeBackfill()" disabled>⟳ Resume</button>
      </div>
    </div>

    <div class="progress-container" id="progressContainer" style="display:none">
      <div class="progress-bar">
        <div class="progress-fill" id="progressFill" style="width:0%">
          <span id="progressPercent">0%</span>
        </div>
      </div>
      <div class="progress-stats">
        <div class="stat-box">
          <div class="stat-label">Channels / Pages</div>
          <div class="stat-value"><span id="statPages">0</span>/<span id="statTotalPages">?</span></div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Downloaded</div>
          <div class="stat-value" id="statDownloaded">0</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Ingested</div>
          <div class="stat-value" id="statIngested">0</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Errors</div>
          <div class="stat-value" id="statErrors">0</div>
        </div>
      </div>
      <div style="margin-top:12px;padding:8px;background:#fdf4ff;border-radius:4px;border-left:4px solid #4A154B">
        <strong>ETA:</strong> <span id="eta">—</span>
      </div>
    </div>

    <div class="events-section">
      <div class="events-header">Live Events</div>
      <div class="events-list" id="eventsList">
        <div style="padding:12px;color:#9ca3af;text-align:center">No events yet</div>
      </div>
    </div>

    <div class="runs-section">
      <div class="runs-header">Last 10 Items</div>
      <table>
        <thead>
          <tr><th>Filename</th><th>Message ID</th><th>Status</th><th>Size</th></tr>
        </thead>
        <tbody id="recentItemsTable">
          <tr><td colspan="4" style="text-align:center;color:#9ca3af">No items yet</td></tr>
        </tbody>
      </table>
    </div>

    <div class="runs-section" style="margin-top:32px">
      <div class="runs-header">Run History</div>
      <table>
        <thead>
          <tr><th>Started</th><th>Mode</th><th>Status</th><th>Downloaded</th><th>Ingested</th><th>Errors</th><th>Duration</th></tr>
        </thead>
        <tbody id="runsTable">
          <tr><td colspan="7" style="text-align:center;color:#9ca3af">Loading...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    const REQUIRES_AUTH = ${requiresAuth};
    let currentRunId = null;
    let eventSource = null;
    const eventLog = [];
    const MAX_EVENTS = 50;

    function getToken() { return localStorage.getItem('backfill-token'); }
    function setToken(t) { localStorage.setItem('backfill-token', t); }
    function getHeaders() { const t = getToken(); return t ? { 'Authorization': 'Bearer ' + t } : {}; }

    function submitToken() {
      const t = document.getElementById('tokenInput').value;
      if (!t) return;
      setToken(t);
      document.getElementById('authModal').classList.remove('active');
      location.reload();
    }

    document.addEventListener('DOMContentLoaded', () => {
      if (REQUIRES_AUTH && !getToken()) document.getElementById('authModal').classList.add('active');
      loadRuns();
      setInterval(loadRuns, 15000);
    });

    async function startBackfill() {
      const mode = document.getElementById('modeSelect').value;
      const batchSize = parseInt(document.getElementById('batchSize').value) || 5;
      const limitVal = document.getElementById('limit').value;
      const limit = limitVal ? parseInt(limitVal) : null;
      const resumeFrom = parseInt(document.getElementById('resumeFrom').value) || 1;
      const dryRun = document.getElementById('dryRun').checked;

      try {
        const res = await fetch('/api/backfill/start', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, getHeaders()),
          body: JSON.stringify({ mode, batchSize, limit, resumeFrom, dryRun }),
        });

        if (res.status === 401) {
          alert('Unauthorized. Clearing token...');
          localStorage.removeItem('backfill-token');
          location.reload();
          return;
        }

        if (!res.ok) {
          const d = await res.json();
          if (d.requiresLogin) { alert('Slack session required. Redirecting to login...'); window.location.href = '/login'; return; }
          alert('Error: ' + (d.error || res.statusText));
          return;
        }

        const data = await res.json();
        currentRunId = data.runId;

        document.getElementById('startBtn').disabled = true;
        document.getElementById('pauseBtn').disabled = false;
        document.getElementById('progressContainer').style.display = 'block';
        document.getElementById('statusSection').style.display = 'block';
        document.getElementById('statusValue').textContent = 'Running';
        document.getElementById('statusSection').className = 'status-section';
        eventLog.length = 0;
        updateEventsList();

        listenEvents(currentRunId);
      } catch (err) {
        alert('Error: ' + err.message);
      }
    }

    function listenEvents(runId) {
      if (eventSource) eventSource.close();
      const t = getToken();
      const params = t ? '?token=' + encodeURIComponent(t) : '';
      eventSource = new EventSource('/api/backfill/events/' + runId + params);

      eventSource.addEventListener('message', e => {
        const p = JSON.parse(e.data);
        updateProgress(p);
      });
      eventSource.addEventListener('complete', () => {
        document.getElementById('statusValue').textContent = 'Complete';
        document.getElementById('startBtn').disabled = false;
        document.getElementById('pauseBtn').disabled = true;
        document.getElementById('resumeBtn').disabled = true;
        eventSource.close();
        loadRuns();
      });
      eventSource.addEventListener('error', e => {
        let msg = 'Error';
        try { msg = 'Error: ' + JSON.parse(e.data).message; } catch {}
        document.getElementById('statusValue').textContent = msg;
        document.getElementById('statusSection').className = 'status-section error';
        document.getElementById('startBtn').disabled = false;
        document.getElementById('pauseBtn').disabled = true;
        document.getElementById('resumeBtn').disabled = true;
        eventSource.close();
        loadRuns();
      });
      eventSource.onerror = () => { eventSource.close(); };
    }

    function updateProgress(p) {
      const pct = p.totalPages > 0 ? Math.round((p.page / p.totalPages) * 100) : 0;
      document.getElementById('progressFill').style.width = pct + '%';
      document.getElementById('progressPercent').textContent = pct + '%';
      document.getElementById('statPages').textContent = p.page;
      document.getElementById('statTotalPages').textContent = p.totalPages || '?';
      document.getElementById('statDownloaded').textContent = p.downloadedCount;
      document.getElementById('statIngested').textContent = p.ingestedCount;
      document.getElementById('statErrors').textContent = p.errorCount;

      if (p.estimatedRemaining && p.estimatedRemaining > 0) {
        const mins = Math.round(p.estimatedRemaining / 1000 / 60);
        document.getElementById('eta').textContent = mins < 60 ? '~' + mins + 'm remaining' : '~' + Math.floor(mins/60) + 'h ' + (mins%60) + 'm remaining';
      }

      if (p.recentItems && p.recentItems.length > 0) updateRecentItems(p.recentItems);
      if (p.lastEvent) addEvent(p.lastEvent);
    }

    function updateRecentItems(items) {
      const tbody = document.getElementById('recentItemsTable');
      if (!items.length) { tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:#9ca3af">No items yet</td></tr>'; return; }
      const colors = { ingested: '#22c55e', downloaded: '#3b82f6', error: '#ef4444', skipped: '#f59e0b' };
      tbody.innerHTML = items.map(item => {
        const size = item.size ? (item.size / 1024).toFixed(1) + ' KB' : '—';
        const color = colors[item.status] || '#6b7280';
        return '<tr><td>' + esc(item.filename) + '</td><td style="font-family:monospace;font-size:.8rem">' + esc(item.messageId.slice(0,20)) + '</td><td><span style="background:' + color + ';color:white;padding:2px 6px;border-radius:3px;font-size:.75rem;font-weight:600">' + item.status.toUpperCase() + '</span></td><td>' + size + '</td></tr>';
      }).join('');
    }

    function addEvent(msg) {
      eventLog.unshift({ time: new Date().toLocaleTimeString(), msg });
      if (eventLog.length > MAX_EVENTS) eventLog.pop();
      updateEventsList();
    }

    function updateEventsList() {
      const list = document.getElementById('eventsList');
      list.innerHTML = eventLog.length === 0
        ? '<div style="padding:12px;color:#9ca3af;text-align:center">No events yet</div>'
        : eventLog.map(e => '<div class="event-item"><span class="event-time">[' + e.time + ']</span><span class="event-text">' + esc(e.msg) + '</span></div>').join('');
    }

    async function pauseBackfill() {
      if (!currentRunId) return;
      const res = await fetch('/api/backfill/pause', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, getHeaders()),
        body: JSON.stringify({ runId: currentRunId }),
      });
      if (res.ok) {
        document.getElementById('statusValue').textContent = 'Paused';
        document.getElementById('pauseBtn').disabled = true;
        document.getElementById('resumeBtn').disabled = false;
        addEvent('Backfill paused');
        if (eventSource) eventSource.close();
      }
    }

    async function resumeBackfill() {
      if (!currentRunId) return;
      const res = await fetch('/api/backfill/resume', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, getHeaders()),
        body: JSON.stringify({ runId: currentRunId }),
      });
      if (res.ok) {
        document.getElementById('statusValue').textContent = 'Running';
        document.getElementById('pauseBtn').disabled = false;
        document.getElementById('resumeBtn').disabled = true;
        addEvent('Backfill resumed');
        listenEvents(currentRunId);
      }
    }

    async function loadRuns() {
      try {
        const res = await fetch('/api/backfill/runs', { headers: getHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const tbody = document.getElementById('runsTable');
        if (!data.runs.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#9ca3af">No runs yet</td></tr>'; return; }
        tbody.innerHTML = data.runs.map(run => {
          const started = new Date(run.startedAt);
          const ended = run.completedAt ? new Date(run.completedAt) : null;
          const dur = ended ? Math.round((ended - started) / 1000) : '—';
          const durStr = dur === '—' ? '—' : dur < 60 ? dur + 's' : Math.round(dur/60) + 'm';
          const cls = { complete: 'badge-complete', running: 'badge-running', error: 'badge-error', paused: 'badge-paused' }[run.status] || '';
          return '<tr><td>' + started.toLocaleString() + '</td><td>' + (run.mode || 'slack-api') + '</td><td><span class="badge ' + cls + '">' + run.status + '</span></td><td>' + (run.stats?.downloadedAttachments ?? 0) + '</td><td>' + (run.stats?.ingestedAttachments ?? 0) + '</td><td>' + (run.stats?.errors ?? 0) + '</td><td>' + durStr + '</td></tr>';
        }).join('');
      } catch {}
    }

    function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }
  </script>
</body>
</html>`;
}

export default router;
