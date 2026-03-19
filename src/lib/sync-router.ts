import { Router, type Request, type Response, type NextFunction } from 'express';
import { hasSession } from './session.js';
import { validateSession, listChannels } from './slack-api.js';
import { syncSlackChannel, fetchChannelName } from './live-sync.js';
import { isApiMode } from './api-writer.js';
import {
  loadJobs,
  createJob,
  getJob,
  updateJob,
  deleteJob,
  resetJobs,
} from './job-store.js';
import { getRecentRuns, createRun, updateRun } from './run-store.js';
import { scheduleJob, unscheduleJob, runJobNow } from './scheduler.js';
import { enqueue, getQueueStatus } from './scheduler-queue.js';
import {
  isSincePreset,
  isCadencePreset,
  resolveSincePreset,
  SINCE_PRESETS,
  CADENCE_PRESETS,
  CADENCE_BOUNDARY_LABELS,
  CADENCE_PRESET_MINUTES,
  COMPACT_PRESET_LABELS,
  type SincePreset,
  type CadencePreset,
} from './since-presets.js';

const router = Router();

// ── Auth middleware ────────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const uiToken = process.env.UI_TOKEN;
  if (!uiToken) {
    next();
    return;
  }

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

// ── Sync UI page ────────────────────────────────────────────────────────────────

router.get('/sync', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildSyncUI());
});

// ── API: session status for UI ──────────────────────────────────────────────────

router.get('/api/session/status', async (_req: Request, res: Response) => {
  if (!hasSession()) {
    res.json({ authenticated: false });
    return;
  }
  const validation = await validateSession();
  res.json({
    authenticated: validation.valid,
    team: validation.team,
    user: validation.user,
    error: validation.error,
  });
});

// ── API: channels list (cached 15min) ───────────────────────────────────────────

router.get('/api/channels', requireAuth, async (_req: Request, res: Response) => {
  if (!hasSession()) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const result = await listChannels();
  if (result.error) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.channels);
});

// ── API: manual sync ────────────────────────────────────────────────────────────

router.post('/api/sync', requireAuth, async (req: Request, res: Response) => {
  const { channel, limit, oldest, latest, sincePreset: sincePresetRaw } = req.body as {
    channel?: string;
    limit?: string | number;
    oldest?: string;
    latest?: string;
    sincePreset?: string;
  };

  if (!channel || typeof channel !== 'string' || !channel.trim()) {
    res.status(400).json({ error: 'channel is required.' });
    return;
  }

  // Validate sincePreset if provided
  const sincePreset: SincePreset | undefined =
    sincePresetRaw && isSincePreset(sincePresetRaw) ? sincePresetRaw : undefined;
  if (sincePresetRaw && !sincePreset) {
    res.status(400).json({
      error: `Invalid sincePreset '${sincePresetRaw}'. Valid values: ${SINCE_PRESETS.join(', ')}`,
    });
    return;
  }

  if (!isApiMode() && !process.env.DATABASE_URL) {
    res.status(500).json({
      error: 'DATABASE_URL is not configured and API mode (MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN) is not active.',
    });
    return;
  }

  if (!hasSession()) {
    res.status(500).json({ error: 'No Slack session. Please log in first via /login.' });
    return;
  }

  const validation = await validateSession();
  if (!validation.valid) {
    res.status(500).json({ error: `Slack session invalid: ${validation.error}. Please log in again.` });
    return;
  }

  const parsedLimit =
    limit !== undefined && limit !== '' ? parseInt(String(limit), 10) : undefined;

  // Resolve effective oldest: sincePreset overrides explicit `oldest`
  const staticOldest = oldest?.trim() || undefined;
  const now = new Date();
  const effectiveOldest = sincePreset
    ? resolveSincePreset(sincePreset, now)
    : staticOldest;

  const startedAt = now.toISOString();
  const channelName = await fetchChannelName(channel.trim()).catch(() => null);

  // Create run record immediately (status: 'queued' until the worker starts)
  const run = await createRun({
    startedAt,
    status: 'queued',
    channel: channel.trim(),
    channelName: channelName || undefined,
    params: {
      limit: parsedLimit,
      after: staticOldest,
      before: latest?.trim() || undefined,
      sincePreset: sincePreset,
      effectiveAfter: effectiveOldest,
    },
    fetchedCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    attachmentsSeen: 0,
  });

  let syncResult: { fetched: number; inserted: number; updated: number; skipped: number; attachmentsSeen: number } | null = null;
  let syncError: string | null = null;

  const { promise } = enqueue(`manual:${run.runId}`, `manual sync #${channel.trim()}`, async () => {
    await updateRun(run.runId, { status: 'running' });

    try {
      const result = await syncSlackChannel(channel.trim(), {
        oldest: effectiveOldest,
        latest: latest?.trim() || undefined,
        limit: parsedLimit,
        verbose: false,
      });

      const finishedAt = new Date().toISOString();
      await updateRun(run.runId, {
        finishedAt,
        status: 'success',
        fetchedCount: result.fetched,
        insertedCount: result.inserted,
        updatedCount: result.updated,
        skippedCount: result.skipped,
        attachmentsSeen: result.attachmentsSeen,
      });

      syncResult = result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await updateRun(run.runId, {
        finishedAt: new Date().toISOString(),
        status: 'error',
        error: message,
      });
      syncError = message;
      throw err;
    }
  });

  await promise.catch(() => { /* error captured in syncError */ });

  if (syncError) {
    res.status(500).json({ error: syncError, runId: run.runId });
    return;
  }

  res.json({
    success: true,
    runId: run.runId,
    channel: channel.trim(),
    channelName: channelName || null,
    user: validation.user,
    sincePreset: sincePreset ?? null,
    effectiveOldest: effectiveOldest ?? null,
    ...(syncResult ?? {}),
  });
});

// ── API: jobs ───────────────────────────────────────────────────────────────────

router.get('/api/jobs', requireAuth, async (_req: Request, res: Response) => {
  const jobs = await loadJobs();
  res.json(jobs);
});

router.post('/api/jobs', requireAuth, async (req: Request, res: Response) => {
  const {
    name,
    channel,
    limit,
    after,
    before,
    sincePreset: sincePresetRaw,
    cadencePreset: cadencePresetRaw,
    intervalMinutes: intervalMinutesRaw,
    enabled,
  } = req.body as {
    name?: string;
    channel?: string;
    limit?: number;
    after?: string;
    before?: string;
    sincePreset?: string;
    cadencePreset?: string;
    intervalMinutes?: number;
    enabled?: boolean;
  };

  if (!channel || !channel.trim()) {
    res.status(400).json({ error: 'channel is required.' });
    return;
  }

  // Validate cadencePreset
  const cadencePreset: CadencePreset | undefined =
    cadencePresetRaw && isCadencePreset(cadencePresetRaw) ? cadencePresetRaw : undefined;
  if (cadencePresetRaw && !cadencePreset) {
    res.status(400).json({
      error: `Invalid cadencePreset '${cadencePresetRaw}'. Valid values: ${CADENCE_PRESETS.join(', ')}`,
    });
    return;
  }

  // Derive intervalMinutes
  const intervalMinutes = cadencePreset
    ? CADENCE_PRESET_MINUTES[cadencePreset]
    : (intervalMinutesRaw !== undefined && Number(intervalMinutesRaw) > 0
        ? Number(intervalMinutesRaw)
        : 60);

  // Validate sincePreset
  const sincePreset: SincePreset | undefined =
    sincePresetRaw && isSincePreset(sincePresetRaw) ? sincePresetRaw : undefined;
  if (sincePresetRaw && !sincePreset) {
    res.status(400).json({
      error: `Invalid sincePreset '${sincePresetRaw}'. Valid values: ${SINCE_PRESETS.join(', ')}`,
    });
    return;
  }

  // Default sincePreset to cadencePreset if not specified
  const effectiveSincePreset: SincePreset | undefined =
    sincePreset ?? (cadencePreset as SincePreset | undefined);

  // Auto-generate job name
  let jobName = (name ?? '').trim();
  if (!jobName) {
    let channelLabel = channel.trim();
    const channelResolved = await fetchChannelName(channel.trim()).catch(() => null);
    if (channelResolved) channelLabel = channelResolved;
    const cadenceLabel = cadencePreset
      ? COMPACT_PRESET_LABELS[cadencePreset as SincePreset]
      : `${intervalMinutes}m`;
    jobName = `#${channelLabel} every ${cadenceLabel}`;
  }

  const job = await createJob({
    name: jobName,
    channel: channel.trim(),
    limit: limit !== undefined ? Number(limit) : undefined,
    after: after?.trim() || undefined,
    before: before?.trim() || undefined,
    sincePreset: effectiveSincePreset,
    cadencePreset,
    intervalMinutes,
    enabled: enabled !== false,
  });

  if (job.enabled) {
    scheduleJob(job);
  }

  res.status(201).json(job);
});

router.post('/api/jobs/:id/run', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const job = await getJob(id);
  if (!job) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }

  const conflictMode = (req.body?.conflict_mode as string | undefined) ?? (req.query.conflict_mode as string | undefined);

  runJobNow(job, conflictMode ? { conflictMode } : undefined).catch((err: unknown) => {
    console.error(`[API] runJobNow error for job ${job.id}:`, err);
  });

  res.json({ success: true, message: 'Job enqueued. Check /api/runs for result.' });
});

router.post('/api/jobs/:id/run-all', requireAuth, async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const job = await getJob(id);
  if (!job) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }

  const conflictMode = (req.body?.conflict_mode as string | undefined) ?? (req.query.conflict_mode as string | undefined);

  // Full history backfill: use 'all' since preset, no limit
  runJobNow(job, {
    sincePreset: 'all',
    limit: undefined,
    before: undefined,
    after: undefined,
    conflictMode,
  }).catch((err: unknown) => {
    console.error(`[API] run-all error for job ${job.id}:`, err);
  });

  res.json({ success: true, message: 'Run-all enqueued. Check /api/runs for progress/result.' });
});

// ── API: scheduler queue status ─────────────────────────────────────────────────

router.get('/api/scheduler/status', requireAuth, (_req: Request, res: Response) => {
  res.json(getQueueStatus());
});

router.patch('/api/jobs/:id', requireAuth, async (req: Request, res: Response) => {
  const {
    name,
    channel,
    limit,
    after,
    before,
    sincePreset: sincePresetRaw,
    cadencePreset: cadencePresetRaw,
    intervalMinutes: intervalMinutesRaw,
    enabled,
    startDate,
    lastSyncedAt,
  } = req.body as {
    name?: string;
    channel?: string;
    limit?: number | null;
    after?: string | null;
    before?: string | null;
    sincePreset?: string | null;
    cadencePreset?: string | null;
    intervalMinutes?: number;
    enabled?: boolean;
    startDate?: string | null;
    lastSyncedAt?: string | null;
  };

  const jobId = String(req.params.id);
  const patch: Record<string, unknown> = {};
  if (name !== undefined) patch.name = String(name).trim();
  if (channel !== undefined) patch.channel = String(channel).trim();
  if (limit !== undefined) patch.limit = limit === null ? undefined : Number(limit);
  if (after !== undefined) patch.after = after === null ? undefined : String(after).trim() || undefined;
  if (before !== undefined) patch.before = before === null ? undefined : String(before).trim() || undefined;
  if (enabled !== undefined) patch.enabled = Boolean(enabled);
  if (startDate !== undefined) patch.startDate = startDate === null || startDate === '' ? undefined : String(startDate).trim() || undefined;
  if (lastSyncedAt !== undefined) patch.lastSyncedAt = lastSyncedAt === null || lastSyncedAt === '' ? undefined : String(lastSyncedAt).trim() || undefined;

  if (cadencePresetRaw !== undefined) {
    if (cadencePresetRaw === null || cadencePresetRaw === '') {
      patch.cadencePreset = undefined;
    } else if (isCadencePreset(cadencePresetRaw)) {
      patch.cadencePreset = cadencePresetRaw;
      patch.intervalMinutes = CADENCE_PRESET_MINUTES[cadencePresetRaw];
    } else {
      res.status(400).json({
        error: `Invalid cadencePreset '${cadencePresetRaw}'. Valid values: ${CADENCE_PRESETS.join(', ')}`,
      });
      return;
    }
  } else if (intervalMinutesRaw !== undefined) {
    patch.intervalMinutes = Math.max(1, Number(intervalMinutesRaw));
  }

  if (sincePresetRaw !== undefined) {
    if (sincePresetRaw === null || sincePresetRaw === '') {
      patch.sincePreset = undefined;
    } else if (isSincePreset(sincePresetRaw)) {
      patch.sincePreset = sincePresetRaw;
    } else {
      res.status(400).json({
        error: `Invalid sincePreset '${sincePresetRaw}'. Valid values: ${SINCE_PRESETS.join(', ')}`,
      });
      return;
    }
  }

  const updated = await updateJob(jobId, patch as Parameters<typeof updateJob>[1]);
  if (!updated) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }

  if (updated.enabled) {
    scheduleJob(updated);
  } else {
    unscheduleJob(updated.id);
  }

  res.json(updated);
});

router.post('/api/jobs/:id/reset-sync', requireAuth, async (req: Request, res: Response) => {
  const jobId = String(req.params.id);
  const job = await updateJob(jobId, { lastSyncedAt: undefined } as Parameters<typeof updateJob>[1]);
  if (!job) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }
  res.json(job);
});

router.delete('/api/jobs/:id', requireAuth, async (req: Request, res: Response) => {
  const delId = String(req.params.id);
  unscheduleJob(delId);
  const ok = await deleteJob(delId);
  if (!ok) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }
  res.json({ success: true });
});

// Reset all jobs (nuclear option for corrupt state)
router.post('/api/jobs/reset', requireAuth, async (_req: Request, res: Response) => {
  await resetJobs();
  res.json({ success: true, message: 'All jobs cleared.' });
});

// ── API: runs ───────────────────────────────────────────────────────────────────

router.get('/api/runs', requireAuth, async (req: Request, res: Response) => {
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 50;
  const runs = await getRecentRuns(Math.min(Math.max(1, limit), 200));
  res.json(runs);
});

// ── HTML UI builder ─────────────────────────────────────────────────────────────

function buildSyncUI(): string {
  const requiresAuth = Boolean(process.env.UI_TOKEN);

  const cadenceOptions = CADENCE_PRESETS.map(p =>
    `<option value="${p}">${COMPACT_PRESET_LABELS[p as SincePreset]}</option>`
  ).join('\n      ');

  const sinceOptions = SINCE_PRESETS.map(p =>
    `<option value="${p}">${COMPACT_PRESET_LABELS[p]}</option>`
  ).join('\n      ');

  const jsCompactLabels = JSON.stringify(
    Object.fromEntries(SINCE_PRESETS.map(p => [p, COMPACT_PRESET_LABELS[p]]))
  );
  const jsCadenceBoundaries = JSON.stringify(CADENCE_BOUNDARY_LABELS);
  const jsCadencePresetsArr = JSON.stringify(CADENCE_PRESETS);
  const jsAllSincePresetsArr = JSON.stringify(SINCE_PRESETS);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Slack Live Sync — OpenClaw</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#1a1a1a;color:#e0e0e0;font-family:system-ui,sans-serif;min-height:100vh;padding:24px 16px}
.page{max-width:900px;margin:0 auto}
h1{font-size:1.5rem;font-weight:700;color:#fff}
.subtitle{color:#888;font-size:.875rem;margin-bottom:20px;margin-top:2px}
.card{background:#2a2a2a;border:1px solid #3d3d3d;border-radius:12px;padding:20px;margin-bottom:16px}
.card-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.card-title{font-size:1rem;font-weight:600;color:#ccc}
.field{margin-bottom:14px}
label{display:block;font-size:.78rem;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
.field-hint{font-size:.76rem;color:#666;margin-bottom:5px;line-height:1.4}
input[type=text],input[type=password],input[type=number],select{width:100%;background:#383838;border:1px solid #555;color:#e0e0e0;border-radius:6px;padding:8px 11px;font-size:.88rem;outline:none;transition:border-color .15s}
input:focus,select:focus{border-color:#4A154B;box-shadow:0 0 0 2px rgba(74,21,75,.25)}
input::placeholder{color:#555}
select option{background:#2a2a2a}
.badge{display:inline-block;font-size:.62rem;padding:1px 5px;border-radius:4px;vertical-align:middle;margin-left:5px;text-transform:uppercase;letter-spacing:.04em;font-weight:700}
.badge-req{background:#4A154B;color:#fff}
.badge-opt{background:#4f545c;color:#aaa}
.btn{display:inline-flex;align-items:center;gap:6px;border:none;border-radius:6px;padding:8px 14px;font-size:.85rem;font-weight:600;cursor:pointer;transition:background .15s;white-space:nowrap}
.btn-primary{background:#4A154B;color:#fff;width:100%;justify-content:center;padding:10px;font-size:.95rem;border-radius:8px;margin-top:4px}
.btn-primary:hover:not(:disabled){background:#611f69}
.btn-primary:disabled{background:#374151;cursor:not-allowed;color:#6b7280}
.btn-sm{padding:4px 9px;font-size:.78rem;border-radius:5px}
.btn-success{background:#22c55e;color:#000}
.btn-success:hover{background:#16a34a}
.btn-warn{background:#f59e0b;color:#000}
.btn-warn:hover{background:#d97706}
.btn-danger{background:#ef4444;color:#fff}
.btn-danger:hover{background:#dc2626}
.btn-ghost{background:#4f545c;color:#ccc}
.btn-ghost:hover{background:#67707b}
.btn-run{background:#4A154B;color:#fff}
.btn-run:hover{background:#611f69}
.top-bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px}
.top-bar-left{display:flex;flex-direction:column}
#auth-bar{display:flex;align-items:center;gap:8px;margin-top:4px}
.auth-status{font-size:.78rem;color:#aaa}
.auth-status.ok{color:#22c55e}
.nav-link{color:#9c27b0;font-size:.82rem;text-decoration:none}
.nav-link:hover{text-decoration:underline}
.login-status-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#1e1e1e;border:1px solid #3d3d3d;border-radius:6px;font-size:.82rem;margin-bottom:12px}
.login-dot{width:10px;height:10px;border-radius:50%;background:#555;flex-shrink:0}
.login-dot.ok{background:#22c55e}
.login-dot.err{background:#ef4444}
.result-box{margin-top:12px;background:#1e1e1e;border:1px solid #555;border-radius:8px;padding:14px;font-size:.82rem}
.result-box.ok{border-color:#22c55e}
.result-box.err{border-color:#ef4444}
.result-label{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:6px}
pre{white-space:pre-wrap;word-break:break-word;font-family:'Courier New',monospace;font-size:.8rem;color:#e0e0e0;line-height:1.5}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:spin .65s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
table{width:100%;border-collapse:collapse;font-size:.8rem}
thead th{color:#888;font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:6px 8px;border-bottom:1px solid #3d4046;text-align:left}
tbody td{padding:7px 8px;border-bottom:1px solid #2a2d31;vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tbody tr:hover td{background:rgba(255,255,255,.03)}
.status-pill{display:inline-block;font-size:.68rem;font-weight:700;padding:2px 7px;border-radius:99px;letter-spacing:.04em}
.pill-ok{background:rgba(34,197,94,.15);color:#22c55e;border:1px solid rgba(34,197,94,.3)}
.pill-err{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3)}
.pill-run{background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}
.pill-dis{background:rgba(100,116,139,.15);color:#64748b;border:1px solid rgba(100,116,139,.3)}
.pill-blue{background:rgba(156,39,176,.15);color:#ce93d8;border:1px solid rgba(156,39,176,.3)}
.empty-row{text-align:center;color:#555;padding:20px;font-size:.85rem}
.actions{display:flex;gap:4px;flex-wrap:wrap}
.mono{font-family:'Courier New',monospace;font-size:.78rem;color:#ce93d8}
.err-text{color:#f87171;font-size:.75rem}
/* Auth modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;z-index:100;backdrop-filter:blur(3px)}
.modal-card{background:#2a2a2a;border:1px solid #4A154B;border-radius:14px;padding:28px;width:100%;max-width:420px;box-shadow:0 16px 40px rgba(0,0,0,.5)}
.modal-card h2{font-size:1.1rem;font-weight:700;color:#fff;margin-bottom:6px}
.modal-card p{color:#888;font-size:.85rem;margin-bottom:18px;line-height:1.5}
.modal-card label{font-size:.78rem;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:5px}
.modal-card input{width:100%;background:#383838;border:1px solid #555;color:#e0e0e0;border-radius:6px;padding:10px 12px;font-size:.9rem;outline:none;margin-bottom:12px}
.modal-card input:focus{border-color:#4A154B}
.modal-err{color:#f87171;font-size:.8rem;margin-bottom:8px;display:none}
.scroll-x{overflow-x:auto}
.field-disabled input,.field-disabled select{opacity:.45;cursor:not-allowed}
.field-disabled label{opacity:.6}
.since-override-note{font-size:.74rem;color:#f59e0b;margin-top:4px;display:none}
/* queue widget */
.queue-row{display:flex;gap:20px;flex-wrap:wrap;align-items:center}
.queue-stat{display:flex;flex-direction:column;align-items:center;gap:2px}
.queue-stat .qs-value{font-size:1.4rem;font-weight:700;color:#fff;line-height:1}
.queue-stat .qs-label{font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:#666}
.queue-ids{font-size:.76rem;color:#9ca3af;margin-top:8px;line-height:1.5}
.queue-ids strong{color:#ccc}
.field-disabled .since-override-note{display:block}
.auto-name-preview{font-size:.78rem;color:#9c27b0;margin-top:4px;min-height:1.1em}
.boundary-info{font-size:.74rem;color:#9ca3af;background:#1e1e1e;border:1px solid #3d4046;border-radius:5px;padding:6px 9px;margin-top:5px;line-height:1.4}
.boundary-info strong{color:#d1d5db}
/* Edit job modal */
.edit-modal-card{max-width:520px;border-color:#555}
.edit-modal-card h2{margin-bottom:14px}
.edit-row{display:flex;gap:12px;align-items:flex-end;margin-bottom:14px}
.edit-row .edit-col{flex:1;min-width:0}
.edit-row .edit-col label{display:block;font-size:.78rem;font-weight:600;color:#aaa;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
.edit-row .edit-col select{width:100%}
.edit-link-col{display:flex;flex-direction:column;align-items:center;padding-bottom:4px;gap:3px;min-width:44px}
.edit-link-col .link-label{font-size:.68rem;color:#888;text-transform:uppercase;letter-spacing:.04em}
.edit-link-col input[type=checkbox]{width:20px;height:20px;cursor:pointer;accent-color:#4A154B}
.edit-enabled-row{display:flex;align-items:center;gap:8px;margin-bottom:14px}
.edit-enabled-row input[type=checkbox]{width:16px;height:16px;cursor:pointer;accent-color:#4A154B;flex-shrink:0}
.edit-enabled-row label{font-size:.88rem;color:#ccc;text-transform:none;letter-spacing:0;margin-bottom:0;cursor:pointer}
.edit-err{color:#f87171;font-size:.8rem;margin-bottom:8px;display:none}
.edit-footer{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.edit-footer .btn-primary{width:auto;margin-top:0;padding:8px 20px;font-size:.88rem}
</style>
</head>
<body>
<div class="page">

<!-- Auth Modal -->
<div class="modal-overlay" id="auth-modal" style="display:none">
  <div class="modal-card">
    <h2>🔑 Authentication Required</h2>
    <p>This Sync UI requires a token. Enter your <code>UI_TOKEN</code> to unlock access.</p>
    <label>UI Token</label>
    <input type="password" id="modal-token-input" placeholder="Paste your UI_TOKEN here" autocomplete="current-password"/>
    <div class="modal-err" id="modal-err">Incorrect token — please try again.</div>
    <button class="btn btn-primary" onclick="submitModalToken()" style="margin-top:0">Unlock</button>
  </div>
</div>

<div class="top-bar">
  <div class="top-bar-left">
    <h1>🔄 Slack Live Sync</h1>
    <p class="subtitle">Pull messages from Slack channels into the OpenClaw memory database.</p>
  </div>
  <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
    <a class="nav-link" href="/login">← Slack Login</a>
    <div id="auth-bar" style="display:none">
      <span class="auth-status" id="auth-status-text">🔓 Authenticated</span>
      <button class="btn btn-sm btn-ghost" onclick="clearSavedToken()">Clear Token</button>
    </div>
  </div>
</div>

<!-- ── Login Status ── -->
<div class="login-status-bar" id="login-status-bar">
  <span class="login-dot" id="login-dot"></span>
  <span id="login-status-text">Checking Slack session…</span>
  <a class="nav-link" href="/login" style="margin-left:auto">Manage Login →</a>
</div>

<!-- ── Channel List with Batch Operations ── -->
<div class="card" id="channel-list-card">
  <div class="card-header">
    <span class="card-title">📺 Channels</span>
    <div style="display:flex;gap:6px;align-items:center">
      <button class="btn btn-sm btn-ghost" onclick="selectAllChannels()">Select All</button>
      <button class="btn btn-sm btn-ghost" onclick="deselectAllChannels()">Deselect All</button>
      <button class="btn btn-sm btn-run" onclick="massSchedule()" id="mass-schedule-btn" disabled>📅 Mass Schedule</button>
      <button class="btn btn-sm btn-primary" onclick="massBackfill()" id="mass-backfill-btn" disabled>⟳ Mass Backfill</button>
      <button class="btn btn-sm btn-ghost" onclick="loadChannelList()">↻ Refresh</button>
    </div>
  </div>
  <div id="channel-list-container" style="max-height:400px;overflow-y:auto">
    <div style="color:#555;font-size:.85rem;padding:12px 0">Loading channels…</div>
  </div>
  <div id="channel-selection-count" style="font-size:.78rem;color:#888;margin-top:8px"></div>
</div>

<!-- ── Scheduler Queue Status Widget ── -->
<div class="card" id="queue-card">
  <div class="card-header">
    <span class="card-title">⚙️ Scheduler Queue</span>
    <button class="btn btn-sm btn-ghost" onclick="loadQueueStatus()">↻ Refresh</button>
  </div>
  <div id="queue-status-container" style="font-size:.82rem;color:#aaa">Loading…</div>
</div>

<!-- ── New Sync Card ── -->
<div class="card">
  <div class="card-header">
    <span class="card-title">⚡ New Sync</span>
  </div>

  <div class="field">
    <label>Mode</label>
    <p class="field-hint">Choose whether to run a one-off sync immediately, or create a scheduled job that repeats on a boundary-aligned cadence.</p>
    <select id="mode" onchange="onModeChange()">
      <option value="manual">Manual Run — execute immediately</option>
      <option value="scheduled">Scheduled Job — repeat on cadence</option>
    </select>
  </div>

  <!-- Scheduled-only: job name -->
  <div class="field field-sched-only" style="display:none" id="field-name">
    <label>Job Name <span class="badge badge-opt">optional</span></label>
    <p class="field-hint">Leave blank to auto-generate from channel and cadence (e.g. <em>"#general every 1H"</em>).</p>
    <input type="text" id="job-name" placeholder="Leave blank to auto-generate" oninput="updateAutoNamePreview()"/>
    <div class="auto-name-preview" id="auto-name-preview"></div>
  </div>

  <!-- Channel (both modes) -->
  <div class="field">
    <label>Channel <span class="badge badge-req">required</span></label>
    <p class="field-hint">Select a channel from your Slack account, or paste a channel ID manually.</p>
    <select id="channel-select" onchange="onChannelSelect()">
      <option value="">— Loading channels… —</option>
    </select>
    <input type="text" id="channel" placeholder="or paste channel ID (e.g. C0123456789)" autocomplete="off" oninput="updateAutoNamePreview()" style="margin-top:6px"/>
  </div>

  <!-- Cadence (scheduled only) -->
  <div class="field field-sched-only" style="display:none" id="field-cadence">
    <label>Cadence <span class="badge badge-req">required</span></label>
    <p class="field-hint">How often this job runs. Jobs fire on <strong>natural UTC boundaries</strong> — hourly means exactly at :00, daily means midnight UTC, weekly means Monday 00:00 UTC.</p>
    <select id="cadence" onchange="onCadenceChange()">
      ${cadenceOptions}
    </select>
    <div class="boundary-info" id="cadence-boundary-info">
      <strong>Boundary:</strong> <span id="cadence-boundary-text"></span>
    </div>
  </div>

  <!-- Since preset (both modes) -->
  <div class="field">
    <label>Since <span class="badge badge-opt">optional</span></label>
    <p class="field-hint" id="since-hint-manual">Fetch messages from the last N time window. Computed at run time from <em>now − window</em>. Overrides the Oldest field when set.</p>
    <p class="field-hint" id="since-hint-scheduled" style="display:none">Lookback window per run. Defaults to the same value as the cadence (e.g. hourly cadence → fetch last 1 hour).</p>
    <select id="since-preset" onchange="onSinceChange()">
      <option value="">— Default (cadence window in scheduled / latest messages in manual) —</option>
      ${sinceOptions}
    </select>
  </div>

  <!-- Oldest (manual only) -->
  <div class="field field-manual-only" id="field-oldest">
    <label>Oldest <span class="badge badge-opt">optional</span></label>
    <p class="field-hint">Fetch messages after this Slack timestamp (Unix seconds, e.g. <code>1677890123.456789</code>). Ignored when a Since preset is selected.</p>
    <input type="text" id="oldest" placeholder="e.g. 1677890123.456789" autocomplete="off"/>
    <div class="since-override-note">⚠ Since preset is active — this Oldest value will be ignored.</div>
  </div>

  <!-- Limit (manual only) -->
  <div class="field field-manual-only" id="field-limit">
    <label>Limit <span class="badge badge-opt">optional</span></label>
    <p class="field-hint">Max messages to fetch per run. Leave blank to fetch all available.</p>
    <input type="number" id="limit" min="1" placeholder="All"/>
  </div>

  <!-- Latest (manual only) -->
  <div class="field field-manual-only" id="field-latest">
    <label>Latest <span class="badge badge-opt">optional</span></label>
    <p class="field-hint">Fetch messages before this Slack timestamp. Use for paginating backwards through history.</p>
    <input type="text" id="latest" placeholder="e.g. 1677890123.456789" autocomplete="off"/>
  </div>

  <button class="btn btn-primary" id="submit-btn" onclick="handleSubmit()">▶ Run Sync</button>
  <div id="sync-result"></div>
</div>

<!-- ── Scheduled Jobs Card ── -->
<div class="card">
  <div class="card-header">
    <span class="card-title">📅 Scheduled Jobs</span>
    <button class="btn btn-sm btn-ghost" onclick="loadJobsTable()">↻ Refresh</button>
  </div>
  <div class="scroll-x" id="jobs-container">
    <div style="color:#555;font-size:.85rem">Loading jobs…</div>
  </div>
</div>

<!-- ── Recent Runs Card ── -->
<div class="card">
  <div class="card-header">
    <span class="card-title">📋 Recent Runs</span>
    <button class="btn btn-sm btn-ghost" onclick="loadRunsTable()">↻ Refresh</button>
  </div>
  <div class="scroll-x" id="runs-container">
    <div style="color:#555;font-size:.85rem">Loading runs…</div>
  </div>
</div>

</div><!-- .page -->
<script>
const REQUIRES_AUTH = ${requiresAuth ? 'true' : 'false'};
const TOKEN_KEY = 'slack_sync_ui_token';

const COMPACT_LABELS = ${jsCompactLabels};
const CADENCE_BOUNDARIES = ${jsCadenceBoundaries};
const CADENCE_PRESET_VALUES = ${jsCadencePresetsArr};
const ALL_SINCE_PRESET_VALUES = ${jsAllSincePresetsArr};

// ── Token management ────────────────────────────────────────────────────────
function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function saveToken(val) { localStorage.setItem(TOKEN_KEY, val); }
function clearSavedToken() {
  localStorage.removeItem(TOKEN_KEY);
  updateAuthBar();
  if (REQUIRES_AUTH) showModal();
}
function getHeaders(extra) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  const t = getToken();
  if (t) h['Authorization'] = 'Bearer ' + t;
  return h;
}

// ── Auth modal ──────────────────────────────────────────────────────────────
function showModal() {
  document.getElementById('auth-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('modal-token-input').focus(), 50);
}
function hideModal() { document.getElementById('auth-modal').style.display = 'none'; }

async function submitModalToken() {
  const input = document.getElementById('modal-token-input');
  const errEl = document.getElementById('modal-err');
  const val = input.value.trim();
  if (!val) return;
  errEl.style.display = 'none';
  try {
    const res = await fetch('/api/jobs', { headers: { 'Authorization': 'Bearer ' + val, 'Content-Type': 'application/json' } });
    if (res.status === 401) { errEl.style.display = 'block'; return; }
    saveToken(val);
    hideModal();
    updateAuthBar();
    loadAll();
  } catch {
    errEl.textContent = 'Network error — try again.';
    errEl.style.display = 'block';
  }
}
document.getElementById('modal-token-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitModalToken();
});

function updateAuthBar() {
  const bar = document.getElementById('auth-bar');
  const txt = document.getElementById('auth-status-text');
  if (!REQUIRES_AUTH) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  if (getToken()) {
    txt.textContent = '🔓 Authenticated';
    txt.className = 'auth-status ok';
  } else {
    txt.textContent = '🔒 Not authenticated';
    txt.className = 'auth-status';
  }
}

// ── Login status ────────────────────────────────────────────────────────────
async function loadLoginStatus() {
  const dot = document.getElementById('login-dot');
  const txt = document.getElementById('login-status-text');
  try {
    const res = await fetch('/api/session/status');
    const data = await res.json();
    if (data.authenticated) {
      dot.className = 'login-dot ok';
      txt.textContent = '✅ Logged in' + (data.user ? ' as ' + data.user : '') + (data.team ? ' (' + data.team + ')' : '');
    } else {
      dot.className = 'login-dot err';
      txt.textContent = '❌ Not logged in — sync will fail. Click Manage Login →';
    }
  } catch {
    dot.className = 'login-dot err';
    txt.textContent = 'Could not check login status.';
  }
}

// ── Mode selector ───────────────────────────────────────────────────────────
function onModeChange() {
  const mode = document.getElementById('mode').value;
  const isScheduled = mode === 'scheduled';
  for (const el of document.querySelectorAll('.field-sched-only')) el.style.display = isScheduled ? '' : 'none';
  for (const el of document.querySelectorAll('.field-manual-only')) el.style.display = isScheduled ? 'none' : '';
  document.getElementById('since-hint-manual').style.display = isScheduled ? 'none' : '';
  document.getElementById('since-hint-scheduled').style.display = isScheduled ? '' : 'none';
  document.getElementById('submit-btn').textContent = isScheduled ? '📅 Create Scheduled Job' : '▶ Run Sync';
  onCadenceChange();
  onSinceChange();
  updateAutoNamePreview();
}

function onCadenceChange() {
  const cadence = document.getElementById('cadence').value;
  const boundary = CADENCE_BOUNDARIES[cadence] || '';
  const el = document.getElementById('cadence-boundary-text');
  if (el) el.textContent = boundary;
  updateAutoNamePreview();
}

function updateAutoNamePreview() {
  const mode = document.getElementById('mode').value;
  const nameEl = document.getElementById('auto-name-preview');
  if (!nameEl || mode !== 'scheduled') { if (nameEl) nameEl.textContent = ''; return; }
  const nameFilled = document.getElementById('job-name').value.trim();
  if (nameFilled) { nameEl.textContent = ''; return; }
  const channel = document.getElementById('channel').value.trim() || 'channel';
  const cadence = document.getElementById('cadence').value;
  const label = COMPACT_LABELS[cadence] || cadence;
  nameEl.textContent = 'Auto-name: #' + channel + ' every ' + label;
}

function onSinceChange() {
  const preset = document.getElementById('since-preset').value;
  const fieldOldest = document.getElementById('field-oldest');
  if (!fieldOldest) return;
  if (preset) {
    fieldOldest.classList.add('field-disabled');
    document.getElementById('oldest').disabled = true;
  } else {
    fieldOldest.classList.remove('field-disabled');
    document.getElementById('oldest').disabled = false;
  }
}

// ── Submit handler ──────────────────────────────────────────────────────────
async function handleSubmit() {
  const mode = document.getElementById('mode').value;
  if (mode === 'scheduled') await handleCreateJob();
  else await handleRunSync();
}

async function handleRunSync() {
  const channel = document.getElementById('channel').value.trim();
  if (!channel) { showResult('error', 'Channel ID is required.'); return; }

  const limit = document.getElementById('limit').value.trim();
  const sincePreset = document.getElementById('since-preset').value;
  const oldest = !sincePreset ? document.getElementById('oldest').value.trim() : '';
  const latest = document.getElementById('latest').value.trim();

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Syncing…';

  try {
    const body = { channel };
    if (limit) body.limit = parseInt(limit, 10);
    if (sincePreset) body.sincePreset = sincePreset;
    else if (oldest) body.oldest = oldest;
    if (latest) body.latest = latest;

    const res = await fetch('/api/sync', { method: 'POST', headers: getHeaders(), body: JSON.stringify(body) });
    const data = await res.json();

    if (res.ok && data.success) {
      showResult('ok', '✅ Sync complete', data);
      loadRunsTable();
    } else {
      showResult('error', '❌ Sync failed (HTTP ' + res.status + ')', data);
    }
  } catch (err) {
    showResult('error', '❌ Network error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Run Sync';
  }
}

async function handleCreateJob() {
  const name = document.getElementById('job-name').value.trim();
  const channel = document.getElementById('channel').value.trim();
  const cadence = document.getElementById('cadence').value;
  const sincePreset = document.getElementById('since-preset').value;

  if (!channel) { showResult('error', 'Channel ID is required.'); return; }
  if (!cadence) { showResult('error', 'Cadence is required.'); return; }

  const btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating…';

  try {
    const body = { channel, cadencePreset: cadence, enabled: true };
    if (name) body.name = name;
    if (sincePreset) body.sincePreset = sincePreset;

    const res = await fetch('/api/jobs', { method: 'POST', headers: getHeaders(), body: JSON.stringify(body) });
    const data = await res.json();

    if (res.ok && data.id) {
      showResult('ok', '✅ Scheduled job created: ' + esc(data.name), data);
      loadJobsTable();
      document.getElementById('job-name').value = '';
      document.getElementById('channel').value = '';
      document.getElementById('since-preset').value = '';
      document.getElementById('cadence').value = '1h';
      onCadenceChange(); updateAutoNamePreview(); onSinceChange();
    } else {
      showResult('error', '❌ Failed to create job (HTTP ' + res.status + ')', data);
    }
  } catch (err) {
    showResult('error', '❌ Network error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '📅 Create Scheduled Job';
  }
}

function showResult(type, label, data) {
  const cls = type === 'ok' ? 'ok' : 'err';
  const body = data ? '<pre>' + esc(JSON.stringify(data, null, 2)) + '</pre>' : '';
  document.getElementById('sync-result').innerHTML =
    '<div class="result-box ' + cls + '"><div class="result-label">' + esc(label) + '</div>' + body + '</div>';
}

// ── Jobs table ──────────────────────────────────────────────────────────────
let _loadedJobs = [];
let _apiChannelNames = {};  // channel ID → name from Slack API

async function loadJobsTable() {
  const el = document.getElementById('jobs-container');
  try {
    // Also refresh channel names for deleted channel detection
    try {
      const chRes = await fetch('/api/channels', { headers: getHeaders() });
      if (chRes.ok) {
        const chs = await chRes.json();
        _apiChannelNames = {};
        for (const ch of chs) _apiChannelNames[ch.id] = ch.name;
      }
    } catch {}

    const res = await fetch('/api/jobs', { headers: getHeaders() });
    if (res.status === 401) { el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Not authenticated.</p>'; return; }
    const jobs = await res.json();
    _loadedJobs = jobs;
    el.innerHTML = renderJobsTable(jobs);
  } catch (err) {
    el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Error loading jobs: ' + esc(err.message) + '</p>';
  }
}

function renderJobsTable(jobs) {
  if (!jobs.length) {
    return '<p style="color:#555;font-size:.85rem;padding:12px 0">No scheduled jobs yet. Use the form above in "Scheduled Job" mode.</p>';
  }
  const rows = jobs.map(function(j) {
    const statusPill = j.lastStatus === 'success' ? '<span class="status-pill pill-ok">success</span>'
      : j.lastStatus === 'error' ? '<span class="status-pill pill-err">error</span>'
      : j.lastStatus === 'running' ? '<span class="status-pill pill-run">running</span>'
      : '<span class="status-pill pill-dis">never</span>';
    const enabledPill = j.enabled
      ? '<span class="status-pill pill-ok">enabled</span>'
      : '<span class="status-pill pill-dis">disabled</span>';
    const lastRun = j.lastRunAt ? reltime(j.lastRunAt) : '—';
    const toggleLabel = j.enabled ? 'Disable' : 'Enable';
    const toggleClass = j.enabled ? 'btn-warn' : 'btn-success';

    const cadenceCell = j.cadencePreset
      ? '<span class="status-pill pill-blue" title="' + esc(CADENCE_BOUNDARIES[j.cadencePreset] || '') + '">' + esc(COMPACT_LABELS[j.cadencePreset] || j.cadencePreset) + '</span>'
      : '<span class="mono">' + j.intervalMinutes + 'm</span>';

    const sinceCell = j.sincePreset
      ? '<span class="status-pill pill-run">' + esc(COMPACT_LABELS[j.sincePreset] || j.sincePreset) + '</span>'
      : (j.after ? '<span class="mono" style="font-size:.72rem" title="Static oldest ts">' + esc(j.after.slice(0,14)) + '…</span>' : '—');

    // Channel name with deleted detection
    var channelName = _apiChannelNames[j.channel];
    var isDeleted = !channelName;
    if (isDeleted) {
      // Fall back to name from job (strip "every ..." suffix)
      channelName = j.name.replace(/^#/, '').replace(/ every .*$/, '') || j.channel;
    }
    var channelDisplay = isDeleted
      ? '<div style="display:flex;flex-direction:column;line-height:1.2"><span style="text-decoration:line-through;color:#888">' + esc(channelName) + '</span><span style="color:#ef4444;font-size:.62rem;font-weight:700">[deleted]</span><span class="mono" style="font-size:.72rem;color:#9ca3af">' + esc(j.channel) + '</span></div>'
      : '<div style="display:flex;flex-direction:column;line-height:1.2"><span>#' + esc(channelName) + '</span><span class="mono" style="font-size:.72rem;color:#9ca3af">' + esc(j.channel) + '</span></div>';

    return '<tr>' +
      '<td>' + esc(j.name) + '</td>' +
      '<td>' + channelDisplay + '</td>' +
      '<td>' + cadenceCell + '</td>' +
      '<td>' + sinceCell + '</td>' +
      '<td>' + enabledPill + '</td>' +
      '<td>' + lastRun + '</td>' +
      '<td>' + statusPill + '</td>' +
      '<td><div class="actions">' +
        '<button class="btn btn-sm btn-run" onclick="triggerJobRun(&apos;' + esc(j.id) + '&apos;, this)">▶ Run</button>' +
        '<button class="btn btn-sm btn-primary" onclick="triggerJobRunAll(&apos;' + esc(j.id) + '&apos;, this)">⟳ All</button>' +
        '<button class="btn btn-sm btn-ghost" onclick="editJob(&apos;' + esc(j.id) + '&apos;)">✏ Edit</button>' +
        '<button class="btn btn-sm ' + toggleClass + '" onclick="toggleJob(&apos;' + esc(j.id) + '&apos;, ' + !j.enabled + ', this)">' + toggleLabel + '</button>' +
        '<button class="btn btn-sm btn-danger" onclick="removeJob(&apos;' + esc(j.id) + '&apos;, this)">✕</button>' +
      '</div></td>' +
    '</tr>';
  }).join('');

  return '<table><thead><tr>' +
    '<th>Name</th><th>Channel</th><th>Cadence</th><th>Since</th><th>Status</th><th>Last Run</th><th>Last Result</th><th>Actions</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── Edit modal ──────────────────────────────────────────────────────────────
let _editJobId = null;

function editJob(id) {
  const job = _loadedJobs.find(function(j) { return j.id === id; });
  if (!job) { alert('Job not found — refresh and try again.'); return; }
  openEditModal(job);
}

function openEditModal(job) {
  _editJobId = job.id;
  const cadence = job.cadencePreset || '';
  const since = job.sincePreset !== undefined ? job.sincePreset : cadence;
  const linked = cadence !== '' && (job.sincePreset === cadence || job.sincePreset === undefined);

  const cadenceOpts = CADENCE_PRESET_VALUES.map(function(p) {
    return '<option value="' + esc(p) + '"' + (p === cadence ? ' selected' : '') + '>' + esc(COMPACT_LABELS[p] || p) + '</option>';
  }).join('');
  const sinceOpts = ALL_SINCE_PRESET_VALUES.map(function(p) {
    return '<option value="' + esc(p) + '"' + (p === since ? ' selected' : '') + '>' + esc(COMPACT_LABELS[p] || p) + '</option>';
  }).join('');

  const existing = document.getElementById('edit-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'edit-modal-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML =
    '<div class="modal-card edit-modal-card">' +
      '<h2>✏️ Edit Scheduled Job</h2>' +
      '<div class="field"><label>Job Name</label><input type="text" id="edit-name" value="' + esc(job.name) + '" placeholder="Job name"/></div>' +
      '<div class="field"><label>Channel ID</label><input type="text" id="edit-channel" value="' + esc(job.channel) + '" placeholder="Slack channel ID"/></div>' +
      '<div class="edit-row">' +
        '<div class="edit-col"><label>Cadence</label><select id="edit-cadence" onchange="onEditCadenceChange()">' + cadenceOpts + '</select></div>' +
        '<div class="edit-link-col"><span class="link-label">Link</span><input type="checkbox" id="edit-link"' + (linked ? ' checked' : '') + ' onchange="onEditLinkChange()" title="When linked, Since matches Cadence"/></div>' +
        '<div class="edit-col"><label>Since</label><select id="edit-since"' + (linked ? ' disabled style="opacity:.55"' : '') + '>' + sinceOpts + '</select></div>' +
      '</div>' +
      '<div class="edit-enabled-row"><input type="checkbox" id="edit-enabled"' + (job.enabled ? ' checked' : '') + '/><label for="edit-enabled">Job is enabled</label></div>' +
      '<div class="edit-err" id="edit-err"></div>' +
      '<div class="edit-footer"><button class="btn btn-ghost" onclick="closeEditModal()">Cancel</button><button class="btn btn-primary" id="edit-save-btn" onclick="saveEditJob()">Save Changes</button></div>' +
    '</div>';

  overlay.addEventListener('click', function(e) { if (e.target === overlay) closeEditModal(); });
  document.body.appendChild(overlay);
}

function closeEditModal() {
  const o = document.getElementById('edit-modal-overlay');
  if (o) o.remove();
  _editJobId = null;
}

function onEditCadenceChange() {
  if (!document.getElementById('edit-link').checked) return;
  document.getElementById('edit-since').value = document.getElementById('edit-cadence').value;
}
function onEditLinkChange() {
  const linked = document.getElementById('edit-link').checked;
  const sinceEl = document.getElementById('edit-since');
  if (linked) { sinceEl.value = document.getElementById('edit-cadence').value; sinceEl.disabled = true; sinceEl.style.opacity = '.55'; }
  else { sinceEl.disabled = false; sinceEl.style.opacity = ''; }
}

async function saveEditJob() {
  if (!_editJobId) return;
  const name = document.getElementById('edit-name').value.trim();
  const channel = document.getElementById('edit-channel').value.trim();
  const cadence = document.getElementById('edit-cadence').value;
  const linked = document.getElementById('edit-link').checked;
  const since = linked ? cadence : document.getElementById('edit-since').value;
  const enabled = document.getElementById('edit-enabled').checked;
  const errEl = document.getElementById('edit-err');
  errEl.style.display = 'none';
  if (!channel) { errEl.textContent = 'Channel ID is required.'; errEl.style.display = 'block'; return; }
  const saveBtn = document.getElementById('edit-save-btn');
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="spinner"></span> Saving\u2026';
  const body = { enabled };
  if (name) body.name = name;
  if (channel) body.channel = channel;
  if (cadence) body.cadencePreset = cadence;
  if (since) body.sincePreset = since;
  try {
    const res = await fetch('/api/jobs/' + _editJobId, { method: 'PATCH', headers: getHeaders(), body: JSON.stringify(body) });
    const data = await res.json();
    if (res.ok && data.id) { closeEditModal(); loadJobsTable(); }
    else { errEl.textContent = data.error || 'Unknown error'; errEl.style.display = 'block'; saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
  } catch (err) {
    errEl.textContent = 'Network error: ' + err.message; errEl.style.display = 'block'; saveBtn.disabled = false; saveBtn.textContent = 'Save Changes';
  }
}

async function triggerJobRun(id, btn) {
  const orig = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch('/api/jobs/' + id + '/run', { method: 'POST', headers: getHeaders() });
    const data = await res.json();
    if (res.ok) { btn.textContent = '✓'; setTimeout(function() { btn.textContent = orig; btn.disabled = false; loadJobsTable(); loadRunsTable(); }, 1500); }
    else { alert('Error: ' + (data.error || 'Unknown')); btn.textContent = orig; btn.disabled = false; }
  } catch (err) { alert('Network error: ' + err.message); btn.textContent = orig; btn.disabled = false; }
}

async function triggerJobRunAll(id, btn) {
  if (!confirm('Run ALL history for this channel? This may take a while.')) return;
  const orig = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch('/api/jobs/' + id + '/run-all', { method: 'POST', headers: getHeaders() });
    const data = await res.json();
    if (res.ok) { btn.textContent = '✓'; setTimeout(function() { btn.textContent = orig; btn.disabled = false; loadJobsTable(); loadRunsTable(); }, 1500); }
    else { alert('Error: ' + (data.error || 'Unknown')); btn.textContent = orig; btn.disabled = false; }
  } catch (err) { alert('Network error: ' + err.message); btn.textContent = orig; btn.disabled = false; }
}

async function toggleJob(id, enable, btn) {
  btn.disabled = true;
  try {
    const res = await fetch('/api/jobs/' + id, { method: 'PATCH', headers: getHeaders(), body: JSON.stringify({ enabled: enable }) });
    if (res.ok) loadJobsTable();
    else { const d = await res.json(); alert('Error: ' + (d.error || 'Unknown')); btn.disabled = false; }
  } catch (err) { alert('Network error: ' + err.message); btn.disabled = false; }
}

async function removeJob(id, btn) {
  if (!confirm('Delete this scheduled job?')) return;
  btn.disabled = true;
  try {
    const res = await fetch('/api/jobs/' + id, { method: 'DELETE', headers: getHeaders() });
    if (res.ok) loadJobsTable();
    else { const d = await res.json(); alert('Error: ' + (d.error || 'Unknown')); btn.disabled = false; }
  } catch (err) { alert('Network error: ' + err.message); btn.disabled = false; }
}

// ── Runs table ──────────────────────────────────────────────────────────────
async function loadRunsTable() {
  const el = document.getElementById('runs-container');
  try {
    const res = await fetch('/api/runs?limit=50', { headers: getHeaders() });
    if (res.status === 401) { el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Not authenticated.</p>'; return; }
    const runs = await res.json();
    el.innerHTML = renderRunsTable(runs);
  } catch (err) {
    el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Error loading runs: ' + esc(err.message) + '</p>';
  }
}

function renderRunsTable(runs) {
  if (!runs.length) {
    return '<p style="color:#555;font-size:.85rem;padding:12px 0">No runs recorded yet. Trigger a sync or wait for a scheduled job.</p>';
  }
  const rows = runs.map(function(r) {
    const statusPill = r.status === 'success' ? '<span class="status-pill pill-ok">success</span>'
      : r.status === 'error' ? '<span class="status-pill pill-err">error</span>'
      : r.status === 'queued' ? '<span class="status-pill pill-blue">queued</span>'
      : '<span class="status-pill pill-run">running</span>';
    const source = r.jobId ? '<span class="mono" title="Job ID: ' + esc(r.jobId) + '">scheduled</span>' : 'manual';
    const errCell = r.error ? '<span class="err-text" title="' + esc(r.error) + '">' + esc(r.error.slice(0,40)) + (r.error.length > 40 ? '…' : '') + '</span>' : '—';
    const dur = r.finishedAt ? Math.round((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000) + 's' : '…';
    const sinceCell = r.params && r.params.sincePreset
      ? '<span class="status-pill pill-run" title="effective oldest: ' + esc(r.params.effectiveAfter || '') + '">' + esc(r.params.sincePreset) + '</span>'
      : (r.params && r.params.after ? '<span class="mono" style="font-size:.72rem" title="' + esc(r.params.after) + '">' + esc(r.params.after.slice(0,14)) + '…</span>' : '—');
    const channelCell = r.channelName
      ? '<div style="display:flex;flex-direction:column;line-height:1.2"><span>' + esc(r.channelName) + '</span><span class="mono" style="font-size:.72rem;color:#9ca3af">' + esc(r.channel) + '</span></div>'
      : '<span class="mono">' + esc(r.channel) + '</span>';
    return '<tr>' +
      '<td title="' + esc(r.startedAt) + '">' + reltime(r.startedAt) + '</td>' +
      '<td>' + source + '</td>' +
      '<td>' + channelCell + '</td>' +
      '<td>' + statusPill + '</td>' +
      '<td>' + sinceCell + '</td>' +
      '<td>' + r.fetchedCount + '</td>' +
      '<td>' + r.insertedCount + '</td>' +
      '<td>' + r.updatedCount + '</td>' +
      '<td>' + r.skippedCount + '</td>' +
      '<td>' + r.attachmentsSeen + '</td>' +
      '<td>' + dur + '</td>' +
      '<td>' + errCell + '</td>' +
      '</tr>';
  }).join('');
  return '<table><thead><tr>' +
    '<th>Started</th><th>Source</th><th>Channel</th><th>Status</th><th>Since/Oldest</th>' +
    '<th>Fetched</th><th>Inserted</th><th>Updated</th><th>Skipped</th><th>Attachments</th><th>Duration</th><th>Error</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

// ── Queue status ────────────────────────────────────────────────────────────
async function loadQueueStatus() {
  const el = document.getElementById('queue-status-container');
  if (!el) return;
  try {
    const res = await fetch('/api/scheduler/status', { headers: getHeaders() });
    if (res.status === 401) { el.innerHTML = '<span style="color:#f87171">Not authenticated.</span>'; return; }
    const d = await res.json();
    const runningList = d.runningIds && d.runningIds.length
      ? d.runningIds.map(function(id) { return '<span class="status-pill pill-run">' + esc(id) + '</span>'; }).join(' ')
      : '<span style="color:#555">none</span>';
    const queuedList = d.queuedIds && d.queuedIds.length
      ? d.queuedIds.map(function(id) { return '<span class="status-pill pill-blue">' + esc(id) + '</span>'; }).join(' ')
      : '<span style="color:#555">none</span>';
    el.innerHTML =
      '<div class="queue-row">' +
        '<div class="queue-stat"><div class="qs-value">' + esc(d.runningCount) + '</div><div class="qs-label">Running</div></div>' +
        '<div class="queue-stat"><div class="qs-value">' + esc(d.queuedCount) + '</div><div class="qs-label">Queued</div></div>' +
        '<div class="queue-stat"><div class="qs-value">' + esc(d.concurrency) + '</div><div class="qs-label">Concurrency</div></div>' +
        '<div class="queue-stat"><div class="qs-value">' + esc(d.spacingMs) + 'ms</div><div class="qs-label">Spacing</div></div>' +
      '</div>' +
      '<div class="queue-ids"><strong>Running:</strong> ' + runningList + '</div>' +
      (d.queuedCount > 0 ? '<div class="queue-ids"><strong>Waiting:</strong> ' + queuedList + '</div>' : '');
  } catch (err) {
    if (el) el.innerHTML = '<span style="color:#f87171">Error: ' + esc(err.message) + '</span>';
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function reltime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return Math.round(diff/1000) + 's ago';
  if (diff < 3600000) return Math.round(diff/60000) + 'm ago';
  if (diff < 86400000) return Math.round(diff/3600000) + 'h ago';
  return Math.round(diff/86400000) + 'd ago';
}

// ── Channel picker ──────────────────────────────────────────────────────────
let _channelsLoaded = false;
async function loadChannels() {
  if (_channelsLoaded) return;
  const sel = document.getElementById('channel-select');
  if (!sel) return;
  try {
    const res = await fetch('/api/channels', { headers: getHeaders() });
    if (!res.ok) { sel.innerHTML = '<option value="">— Failed to load channels —</option>'; return; }
    const channels = await res.json();
    let html = '<option value="">— Select a channel —</option>';
    for (const ch of channels) {
      html += '<option value="' + esc(ch.id) + '">#' + esc(ch.name) + '</option>';
    }
    sel.innerHTML = html;
    _channelsLoaded = true;
  } catch (e) {
    sel.innerHTML = '<option value="">— Error loading channels —</option>';
  }
}
function onChannelSelect() {
  const sel = document.getElementById('channel-select');
  const input = document.getElementById('channel');
  if (sel.value) { input.value = sel.value; }
  updateAutoNamePreview();
}

// ── Channel list with checkboxes ────────────────────────────────────────────
let _channelListData = [];
let _jobsByChannel = {};

async function loadChannelList() {
  const el = document.getElementById('channel-list-container');
  try {
    // Load channels and jobs in parallel
    const [chRes, jobsRes] = await Promise.all([
      fetch('/api/channels', { headers: getHeaders() }),
      fetch('/api/jobs', { headers: getHeaders() }),
    ]);

    let channels = [];
    if (chRes.ok) channels = await chRes.json();
    const jobs = jobsRes.ok ? await jobsRes.json() : [];

    // Build a map of channel IDs that have jobs
    _jobsByChannel = {};
    const jobChannelIds = new Set();
    for (const j of jobs) {
      _jobsByChannel[j.channel] = j;
      jobChannelIds.add(j.channel);
    }

    // Build channel ID→name map from API channels
    const apiChannelMap = {};
    for (const ch of channels) apiChannelMap[ch.id] = ch.name;

    // Find deleted channels: in jobs but not in API channel list
    const deletedChannels = [];
    for (const j of jobs) {
      if (!apiChannelMap[j.channel]) {
        deletedChannels.push({
          id: j.channel,
          name: j.name.replace(/^#/, '').replace(/ every .*$/, '') || j.channel,
          isDeleted: true,
        });
      }
    }

    // Merge: API channels + deleted channels from jobs
    _channelListData = [
      ...channels.map(function(ch) {
        return { id: ch.id, name: ch.name, isDeleted: false, hasJob: jobChannelIds.has(ch.id) };
      }),
      ...deletedChannels.map(function(ch) {
        return { id: ch.id, name: ch.name, isDeleted: true, hasJob: true };
      }),
    ];

    renderChannelList();
  } catch (err) {
    el.innerHTML = '<p style="color:#f87171;font-size:.85rem">Error loading channels: ' + esc(err.message) + '</p>';
  }
}

function renderChannelList() {
  const el = document.getElementById('channel-list-container');
  if (!_channelListData.length) {
    el.innerHTML = '<p style="color:#555;font-size:.85rem;padding:12px 0">No channels found.</p>';
    return;
  }
  const rows = _channelListData.map(function(ch) {
    const nameDisplay = ch.isDeleted
      ? '<span style="text-decoration:line-through;color:#888">' + esc(ch.name) + '</span> <span style="color:#ef4444;font-size:.72rem;font-weight:700">[deleted]</span>'
      : esc(ch.name);
    const jobBadge = ch.hasJob
      ? ' <span class="status-pill pill-ok" style="font-size:.6rem">scheduled</span>'
      : '';
    return '<label style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid #2a2d31;cursor:pointer" onmouseover="this.style.background=\\'rgba(255,255,255,.03)\\'" onmouseout="this.style.background=\\'\\'"><input type="checkbox" class="ch-checkbox" value="' + esc(ch.id) + '" data-name="' + esc(ch.name) + '" onchange="updateChannelSelectionCount()"/><span>' + nameDisplay + '</span>' + jobBadge + '<span class="mono" style="font-size:.72rem;color:#9ca3af;margin-left:auto">' + esc(ch.id) + '</span></label>';
  }).join('');
  el.innerHTML = rows;
  updateChannelSelectionCount();
}

function getSelectedChannels() {
  const checks = document.querySelectorAll('.ch-checkbox:checked');
  return Array.from(checks).map(function(cb) { return { id: cb.value, name: cb.getAttribute('data-name') }; });
}

function updateChannelSelectionCount() {
  const selected = getSelectedChannels();
  const el = document.getElementById('channel-selection-count');
  el.textContent = selected.length > 0 ? selected.length + ' channel(s) selected' : '';
  document.getElementById('mass-schedule-btn').disabled = selected.length === 0;
  document.getElementById('mass-backfill-btn').disabled = selected.length === 0;
}

function selectAllChannels() {
  document.querySelectorAll('.ch-checkbox').forEach(function(cb) { cb.checked = true; });
  updateChannelSelectionCount();
}

function deselectAllChannels() {
  document.querySelectorAll('.ch-checkbox').forEach(function(cb) { cb.checked = false; });
  updateChannelSelectionCount();
}

async function massSchedule() {
  const selected = getSelectedChannels();
  if (!selected.length) return;
  const cadence = prompt('Cadence preset for all selected channels (e.g. 1h, 6h, 1d, 1w):', '1h');
  if (!cadence) return;
  const btn = document.getElementById('mass-schedule-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scheduling…';
  let created = 0, errors = 0;
  for (const ch of selected) {
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ channel: ch.id, cadencePreset: cadence, enabled: true }),
      });
      if (res.ok) created++;
      else errors++;
    } catch { errors++; }
  }
  btn.textContent = '📅 Mass Schedule';
  btn.disabled = false;
  alert('Created ' + created + ' job(s)' + (errors ? ', ' + errors + ' error(s)' : ''));
  loadJobsTable();
  loadChannelList();
}

async function massBackfill() {
  const selected = getSelectedChannels();
  if (!selected.length) return;
  if (!confirm('Run full backfill (all history) for ' + selected.length + ' channel(s)? This may take a while.')) return;
  const btn = document.getElementById('mass-backfill-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Backfilling…';
  let triggered = 0, errors = 0;
  for (const ch of selected) {
    // Check if a job exists for this channel; if not, create one first
    let jobId = _jobsByChannel[ch.id]?.id;
    if (!jobId) {
      try {
        const createRes = await fetch('/api/jobs', {
          method: 'POST',
          headers: getHeaders(),
          body: JSON.stringify({ channel: ch.id, cadencePreset: '1d', enabled: false }),
        });
        if (createRes.ok) {
          const newJob = await createRes.json();
          jobId = newJob.id;
        }
      } catch {}
    }
    if (jobId) {
      try {
        const res = await fetch('/api/jobs/' + jobId + '/run-all', { method: 'POST', headers: getHeaders() });
        if (res.ok) triggered++;
        else errors++;
      } catch { errors++; }
    } else {
      errors++;
    }
  }
  btn.textContent = '⟳ Mass Backfill';
  btn.disabled = false;
  alert('Triggered backfill for ' + triggered + ' channel(s)' + (errors ? ', ' + errors + ' error(s)' : ''));
  loadJobsTable();
  loadRunsTable();
}

function loadAll() {
  loadLoginStatus();
  loadChannels();
  loadChannelList();
  loadJobsTable();
  loadRunsTable();
  loadQueueStatus();
}

// ── Init ────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', function() {
  updateAuthBar();
  const cadenceEl = document.getElementById('cadence');
  if (cadenceEl && !cadenceEl.value) cadenceEl.value = '1h';
  onCadenceChange();

  if (REQUIRES_AUTH && !getToken()) {
    showModal();
  } else {
    loadAll();
  }

  setInterval(function() {
    if (REQUIRES_AUTH && !getToken()) return;
    loadAll();
  }, 30000);
});
</script>
</body>
</html>`;
}

export default router;
