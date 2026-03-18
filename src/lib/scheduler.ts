import { loadJobs, updateJob, type Job } from './job-store.js';
import { createRun, updateRun } from './run-store.js';
import { hasSession } from './session.js';
import { validateSession } from './slack-api.js';
import { syncSlackChannel, fetchChannelName } from './live-sync.js';
import { isApiMode } from './api-writer.js';
import {
  computeNextBoundary,
  sincePresetToMs,
  timestampToSlackTs,
} from './since-presets.js';
import { enqueue } from './scheduler-queue.js';

// Timers for each scheduled job
const jobTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearJobTimer(jobId: string): void {
  const t = jobTimers.get(jobId);
  if (t !== undefined) {
    clearTimeout(t);
    jobTimers.delete(jobId);
  }
}

export type JobRunOverrides = {
  limit?: number;
  before?: string;
  after?: string;
  sincePreset?: Job['sincePreset'];
  conflictMode?: string;
};

/**
 * Core execution logic for a scheduled job.
 * Called from within the queue worker — the queue handles per-job overlap guard.
 */
async function executeJob(job: Job, overrides?: JobRunOverrides): Promise<void> {
  if (!isApiMode() && !process.env.DATABASE_URL) {
    console.error(
      '[Scheduler] DATABASE_URL not configured and API mode ' +
      '(MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN) is not active — cannot run job.'
    );
    return;
  }

  if (!hasSession()) {
    console.error(`[Scheduler] No Slack session — skipping job ${job.id} (${job.name}).`);
    await updateJob(job.id, { lastStatus: 'error' });
    return;
  }

  const validation = await validateSession();
  if (!validation.valid) {
    console.error(
      `[Scheduler] Slack session invalid — skipping job ${job.id} (${job.name}): ${validation.error}`
    );
    await updateJob(job.id, { lastStatus: 'error' });
    return;
  }

  // Resolve sincePreset → effective Slack Unix timestamp at runtime.
  // Priority: lastSyncedAt → startDate → sincePreset (legacy) → explicit after → beginning
  const now = new Date();
  const runSincePreset = overrides?.sincePreset ?? job.sincePreset;
  const runAfter = overrides?.after ?? job.after;
  const runBefore = overrides?.before ?? job.before;
  const runLimit = overrides?.limit ?? job.limit;

  // Optional overlap window for scheduled runs to avoid edge misses at boundaries.
  // Default 10% (e.g., 1h cadence => ~66m lookback). Safe because DB upserts are idempotent.
  const overlapPctRaw = Number(process.env.SCHEDULE_SINCE_OVERLAP_PERCENT ?? '10');
  const overlapPct = Number.isFinite(overlapPctRaw) ? Math.min(Math.max(overlapPctRaw, 0), 100) : 10;

  let afterMs: number | null = null;
  if (runSincePreset === 'all') {
    // Full backfill — ignore lastSyncedAt and startDate
    afterMs = null;
  } else if (job.lastSyncedAt && !overrides?.after) {
    afterMs = new Date(job.lastSyncedAt).getTime();
  } else if (job.startDate && !job.lastSyncedAt && !overrides?.after) {
    afterMs = new Date(job.startDate).getTime();
  } else if (runSincePreset) {
    const baseMs = sincePresetToMs(runSincePreset);
    const lookbackMs = Math.round(baseMs * (1 + overlapPct / 100));
    afterMs = now.getTime() - lookbackMs;
  }
  // Apply startDate as a floor even when lastSyncedAt is set
  if (job.startDate && afterMs !== null) {
    const startMs = new Date(job.startDate).getTime();
    afterMs = Math.max(afterMs, startMs);
  }
  // Convert to Slack oldest timestamp (Unix seconds as string)
  const effectiveOldest = afterMs != null ? timestampToSlackTs(afterMs) : runAfter;

  const startedAt = now.toISOString();
  await updateJob(job.id, { lastStatus: 'running', lastRunAt: startedAt });

  const channelName = await fetchChannelName(job.channel).catch(() => null);

  const run = await createRun({
    jobId: job.id,
    startedAt,
    status: 'running',
    channel: job.channel,
    channelName: channelName || undefined,
    params: {
      limit: runLimit,
      after: runAfter,
      before: runBefore,
      sincePreset: runSincePreset,
      effectiveAfter: effectiveOldest,
    },
    fetchedCount: 0,
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    attachmentsSeen: 0,
  });

  const writeMode = isApiMode() ? 'api' : 'pg';

  try {
    console.log(
      `[Scheduler] Starting job ${job.id} (${job.name}) — channel ${job.channel}` +
      (job.cadencePreset ? ` — cadence=${job.cadencePreset}` : '') +
      (runSincePreset ? ` — since=${runSincePreset} (oldest=${effectiveOldest})` : '') +
      ` [write=${writeMode}]`
    );

    const result = await syncSlackChannel(job.channel, {
      oldest: effectiveOldest,
      latest: runBefore,
      limit: runLimit,
      verbose: true,
      conflictMode: overrides?.conflictMode,
    });

    const finishedAt = new Date().toISOString();
    await updateJob(job.id, { lastStatus: 'success', lastRunAt: finishedAt, lastSyncedAt: finishedAt });
    await updateRun(run.runId, {
      finishedAt,
      status: 'success',
      fetchedCount: result.fetched,
      insertedCount: result.inserted,
      updatedCount: result.updated,
      skippedCount: result.skipped,
      attachmentsSeen: result.attachmentsSeen,
    });

    console.log(
      `[Scheduler] Job ${job.id} done — fetched=${result.fetched} inserted=${result.inserted} updated=${result.updated}`
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[Scheduler] Job ${job.id} (${job.name}) failed: ${message}`);

    await updateJob(job.id, { lastStatus: 'error' });
    await updateRun(run.runId, {
      finishedAt: new Date().toISOString(),
      status: 'error',
      error: message,
    });
  }
}

/**
 * Schedule a job to run at its next due time.
 *
 * Scheduling strategy:
 *   - If job has a `cadencePreset`: boundary-aligned UTC scheduling.
 *   - If job has only `intervalMinutes` (legacy): interval-drift scheduling.
 */
export function scheduleJob(job: Job): void {
  clearJobTimer(job.id);

  if (!job.enabled) return;

  let delayMs: number;

  if (job.cadencePreset) {
    const nextBoundary = computeNextBoundary(job.cadencePreset);
    delayMs = Math.max(0, nextBoundary.getTime() - Date.now());
    console.log(
      `[Scheduler] Job ${job.id} (${job.name}) — cadence=${job.cadencePreset}` +
      ` next boundary: ${nextBoundary.toISOString()} (in ${Math.round(delayMs / 1000)}s)`
    );
  } else if (job.lastRunAt) {
    const intervalMs = job.intervalMinutes * 60 * 1000;
    const lastRun = new Date(job.lastRunAt).getTime();
    const nextRun = lastRun + intervalMs;
    delayMs = Math.max(0, nextRun - Date.now());
    console.log(
      `[Scheduler] Job ${job.id} (${job.name}) [legacy] next run in ${Math.round(delayMs / 1000)}s`
    );
  } else {
    delayMs = 5_000;
    console.log(`[Scheduler] Job ${job.id} (${job.name}) first run in ${delayMs / 1000}s`);
  }

  const timer = setTimeout(async () => {
    jobTimers.delete(job.id);

    // Refresh job from disk to respect any edits/disables since scheduling
    const jobs = await loadJobs();
    const current = jobs.find(j => j.id === job.id);

    if (!current) {
      console.log(`[Scheduler] Job ${job.id} no longer exists — dropping.`);
      return;
    }

    if (!current.enabled) {
      console.log(`[Scheduler] Job ${job.id} (${current.name}) disabled — not running.`);
      return;
    }

    const { enqueued } = enqueue(current.id, current.name, () => executeJob(current));
    if (!enqueued) {
      console.log(
        `[Scheduler] Job ${current.id} (${current.name}) boundary fired but already queued/running — skipping.`
      );
    }

    // Reschedule at next boundary (drift-free)
    scheduleJob(current);
  }, delayMs);

  jobTimers.set(job.id, timer);
}

export function unscheduleJob(jobId: string): void {
  clearJobTimer(jobId);
}

/**
 * Immediately enqueue a job outside of the scheduler cadence.
 * After enqueuing, reschedules the timer at the next boundary.
 */
export function runJobNow(job: Job, overrides?: JobRunOverrides): Promise<void> {
  clearJobTimer(job.id);

  const { promise } = enqueue(job.id, job.name, () => executeJob(job, overrides));

  if (job.enabled) {
    scheduleJob(job);
  }

  return promise;
}

export async function startScheduler(): Promise<void> {
  const jobs = await loadJobs();
  const enabledJobs = jobs.filter(j => j.enabled);

  console.log(
    `[Scheduler] Starting — ${jobs.length} total jobs, ${enabledJobs.length} enabled.`
  );

  for (const job of enabledJobs) {
    scheduleJob(job);
  }
}
