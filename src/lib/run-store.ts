import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export interface RunLog {
  runId: string;
  jobId?: string; // undefined for manual runs
  startedAt: string;
  finishedAt?: string;
  status: 'queued' | 'running' | 'success' | 'error';
  error?: string;
  channel: string;
  channelName?: string;
  params: {
    limit?: number;
    /** Static "oldest" Slack Unix timestamp provided by caller (may be overridden by sincePreset). */
    after?: string;
    /** Static "latest" Slack Unix timestamp. */
    before?: string;
    /**
     * The since preset used for this run (e.g. '1h').
     * When set, sincePreset took precedence over any explicit `after`.
     */
    sincePreset?: string;
    /**
     * The resolved Slack Unix timestamp used as the effective `oldest` filter.
     * Populated when sincePreset is used; equals the static `after` otherwise.
     */
    effectiveAfter?: string;
  };
  fetchedCount: number;
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  attachmentsSeen: number;
}

const DATA_DIR = path.resolve(process.cwd(), '.data', 'runs');
const RUNS_FILE = path.join(DATA_DIR, 'runs.json');
const MAX_RUNS = 200;

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadRuns(): Promise<RunLog[]> {
  try {
    const raw = await fs.readFile(RUNS_FILE, 'utf8');
    return JSON.parse(raw) as RunLog[];
  } catch {
    return [];
  }
}

async function saveRuns(runs: RunLog[]): Promise<void> {
  await ensureDir();
  // Keep only the latest MAX_RUNS entries
  const trimmed = runs.length > MAX_RUNS ? runs.slice(-MAX_RUNS) : runs;
  await fs.writeFile(RUNS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

export async function createRun(
  data: Omit<RunLog, 'runId'>
): Promise<RunLog> {
  const runs = await loadRuns();
  const run: RunLog = { ...data, runId: crypto.randomUUID() };
  runs.push(run);
  await saveRuns(runs);
  return run;
}

export async function updateRun(
  runId: string,
  patch: Partial<RunLog>
): Promise<RunLog | null> {
  const runs = await loadRuns();
  const idx = runs.findIndex(r => r.runId === runId);
  if (idx === -1) return null;
  runs[idx] = { ...runs[idx], ...patch };
  await saveRuns(runs);
  return runs[idx];
}

export async function getRecentRuns(limit = 50): Promise<RunLog[]> {
  const runs = await loadRuns();
  // Return newest first
  return runs.slice(-limit).reverse();
}
