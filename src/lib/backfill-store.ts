import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export interface BackfillRun {
  runId: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'paused' | 'complete' | 'error';
  mode: 'memory-db' | 'slack-api';
  options: {
    batchSize: number;
    limit?: number;
    dryRun: boolean;
    resumeFrom: number;
  };
  stats: {
    totalMessages: number;
    messagesWithAttachments: number;
    downloadedAttachments: number;
    ingestedAttachments: number;
    skipped: number;
    errors: number;
  };
  paused: boolean;
  pausedAt?: string;
  lastPage: number;
  totalPages: number;
  error?: string;
}

const DATA_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (process.env.NODE_ENV === 'production'
      ? '/app/.data'
      : path.resolve(process.cwd(), '.data'));
const DATA_DIR = path.join(DATA_ROOT, 'runs');
const BACKFILL_RUNS_FILE = path.join(DATA_DIR, 'backfill-runs.json');
const MAX_RUNS = 200;

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadBackfillRuns(): Promise<BackfillRun[]> {
  try {
    const raw = await fs.readFile(BACKFILL_RUNS_FILE, 'utf8');
    return JSON.parse(raw) as BackfillRun[];
  } catch {
    return [];
  }
}

async function saveBackfillRuns(runs: BackfillRun[]): Promise<void> {
  await ensureDir();
  const trimmed = runs.length > MAX_RUNS ? runs.slice(-MAX_RUNS) : runs;
  await fs.writeFile(BACKFILL_RUNS_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

export async function createBackfillRun(
  options: BackfillRun['options'],
  mode: BackfillRun['mode'] = 'slack-api'
): Promise<BackfillRun> {
  const runs = await loadBackfillRuns();
  const run: BackfillRun = {
    runId: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    status: 'running',
    mode,
    options,
    stats: {
      totalMessages: 0,
      messagesWithAttachments: 0,
      downloadedAttachments: 0,
      ingestedAttachments: 0,
      skipped: 0,
      errors: 0,
    },
    paused: false,
    lastPage: options.resumeFrom ?? 1,
    totalPages: 0,
  };
  runs.push(run);
  await saveBackfillRuns(runs);
  return run;
}

export async function updateBackfillRun(
  runId: string,
  patch: Partial<BackfillRun>
): Promise<BackfillRun | null> {
  const runs = await loadBackfillRuns();
  const idx = runs.findIndex(r => r.runId === runId);
  if (idx === -1) return null;
  runs[idx] = { ...runs[idx], ...patch };
  await saveBackfillRuns(runs);
  return runs[idx];
}

export async function getBackfillRun(runId: string): Promise<BackfillRun | null> {
  const runs = await loadBackfillRuns();
  return runs.find(r => r.runId === runId) ?? null;
}

export async function getRecentBackfillRuns(limit = 50): Promise<BackfillRun[]> {
  const runs = await loadBackfillRuns();
  return runs.slice(-limit).reverse();
}

export async function getActiveBackfillRun(): Promise<BackfillRun | null> {
  const runs = await loadBackfillRuns();
  return runs.find(r => r.status === 'running' && !r.paused) ?? null;
}
