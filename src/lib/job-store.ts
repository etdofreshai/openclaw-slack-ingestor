import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SincePreset, CadencePreset } from './since-presets.js';

export interface Job {
  id: string;
  name: string;
  /** Slack channel/conversation ID, e.g. C0123456789 */
  channel: string;
  limit?: number;
  /**
   * Static "oldest" Slack Unix timestamp filter (e.g. "1677890123.456789").
   * Ignored when sincePreset is set.
   */
  after?: string;
  /**
   * Static "latest" Slack Unix timestamp filter.
   * Limits messages to those before this timestamp.
   */
  before?: string;
  /**
   * Relative lookback window preset (e.g. '1h', '1d').
   * When set, takes precedence over the static `after` field.
   * The effective `oldest` Slack timestamp is computed at runtime from (now - preset).
   *
   * For scheduled jobs: if sincePreset is not set, it defaults to cadencePreset
   * at creation time (fetch messages from the last cadence window each run).
   */
  sincePreset?: SincePreset;
  /**
   * Scheduling cadence preset (e.g. '1h', '1d').
   * When present, the scheduler uses boundary-aligned UTC timing instead of
   * the "lastRun + intervalMinutes" drift approach.
   */
  cadencePreset?: CadencePreset;
  /**
   * Run interval in minutes. For new jobs this is derived from cadencePreset
   * and stored for reference. For old jobs (backward compat) this is the sole
   * scheduling source when cadencePreset is absent.
   */
  intervalMinutes: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: 'success' | 'error' | 'running';
  lastSyncedAt?: string;  // ISO timestamp of last SUCCESSFUL sync
  startDate?: string;     // Optional floor — never fetch messages before this date
}

const DATA_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (process.env.NODE_ENV === 'production'
      ? '/app/.data'
      : path.resolve(process.cwd(), '.data'));

const DATA_DIR = path.join(DATA_ROOT, 'jobs');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const JOBS_BACKUP_FILE = path.join(DATA_DIR, 'jobs.json.bak');

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

// Simple write-lock mutex to prevent concurrent writes
let writeLock: Promise<void> = Promise.resolve();

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: () => void;
  const prev = writeLock;
  writeLock = new Promise<void>(resolve => { release = resolve; });
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
}

/**
 * Attempt to salvage a valid JSON array from a potentially corrupt string.
 * Tries progressively shorter substrings ending with ']' to recover partial data.
 */
function trySalvageJSON(raw: string): Job[] | null {
  // Quick check: is it a valid array already?
  try { const arr = JSON.parse(raw); if (Array.isArray(arr)) return arr as Job[]; } catch {}

  // Try to find the last valid ']' and parse up to it
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) return null;

  for (let i = trimmed.length; i > 1; i--) {
    const lastBracket = trimmed.lastIndexOf(']', i - 1);
    if (lastBracket <= 0) break;
    try {
      const candidate = trimmed.slice(0, lastBracket + 1);
      const arr = JSON.parse(candidate);
      if (Array.isArray(arr) && arr.length > 0) {
        console.warn(`[job-store] Salvaged ${arr.length} jobs from corrupt file (truncated at position ${lastBracket + 1}/${trimmed.length})`);
        return arr as Job[];
      }
    } catch {}
    // Try removing a trailing partial object + comma: [..., {partial]  →  [...}]
    const lastComma = trimmed.lastIndexOf(',', lastBracket - 1);
    if (lastComma > 0) {
      try {
        const candidate = trimmed.slice(0, lastComma) + ']';
        const arr = JSON.parse(candidate);
        if (Array.isArray(arr) && arr.length > 0) {
          console.warn(`[job-store] Salvaged ${arr.length} jobs (dropped last partial entry)`);
          return arr as Job[];
        }
      } catch {}
    }
    break; // Only try the outermost bracket positions
  }
  return null;
}

function tryParseOrSalvage(raw: string, label: string): Job[] | null {
  try {
    return JSON.parse(raw) as Job[];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[job-store] JSON.parse failed for ${label}: ${message}. Attempting salvage...`);
    return trySalvageJSON(raw);
  }
}

export async function loadJobs(): Promise<Job[]> {
  // Try main file first
  try {
    const raw = await fs.readFile(JOBS_FILE, 'utf8');
    const jobs = tryParseOrSalvage(raw, JOBS_FILE);
    if (jobs !== null) return jobs;
    console.warn(`[job-store] Main file unsalvageable. Trying backup...`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // File doesn't exist yet, try backup
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[job-store] Failed to read jobs from ${JOBS_FILE}: ${message}. Trying backup...`);
    }
  }

  // Try backup file
  try {
    const raw = await fs.readFile(JOBS_BACKUP_FILE, 'utf8');
    const jobs = tryParseOrSalvage(raw, JOBS_BACKUP_FILE);
    if (jobs !== null) {
      console.warn(`[job-store] Recovered ${jobs.length} jobs from backup file.`);
      return jobs;
    }
    console.warn(`[job-store] Backup file also unsalvageable.`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[job-store] Failed to read backup jobs from ${JOBS_BACKUP_FILE}: ${message}`);
    }
  }

  // Both corrupt or missing — start fresh
  console.warn(`[job-store] Both main and backup job files are missing or corrupt. Starting with empty job list.`);
  return [];
}

async function saveJobs(jobs: Job[]): Promise<void> {
  await ensureDir();
  const content = JSON.stringify(jobs, null, 2);
  const tmpFile = `${JOBS_FILE}.tmp.${process.pid}.${Date.now()}`;

  // Write to temp file first
  await fs.writeFile(tmpFile, content, 'utf8');

  // Write backup before replacing main file — but only if current file is valid JSON
  try {
    const existing = await fs.readFile(JOBS_FILE, 'utf8');
    // Validate the existing file parses as JSON before using it as backup
    JSON.parse(existing);
    await fs.copyFile(JOBS_FILE, JOBS_BACKUP_FILE);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // No existing file to backup — that's fine
    } else if (err instanceof SyntaxError) {
      console.warn(`[job-store] Skipping backup — existing jobs.json is corrupt (would overwrite good backup)`);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[job-store] Failed to write backup: ${message}`);
    }
  }

  // Atomic rename: temp → main
  await fs.rename(tmpFile, JOBS_FILE);
}

export async function createJob(
  data: Omit<Job, 'id' | 'createdAt' | 'updatedAt'>
): Promise<Job> {
  return withWriteLock(async () => {
    const jobs = await loadJobs();
    const now = new Date().toISOString();
    const job: Job = {
      ...data,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    jobs.push(job);
    await saveJobs(jobs);
    return job;
  });
}

export async function getJob(id: string): Promise<Job | null> {
  const jobs = await loadJobs();
  return jobs.find(j => j.id === id) ?? null;
}

export async function updateJob(
  id: string,
  patch: Partial<Omit<Job, 'id' | 'createdAt'>>
): Promise<Job | null> {
  return withWriteLock(async () => {
    const jobs = await loadJobs();
    const idx = jobs.findIndex(j => j.id === id);
    if (idx === -1) return null;
    jobs[idx] = { ...jobs[idx], ...patch, updatedAt: new Date().toISOString() };
    await saveJobs(jobs);
    return jobs[idx];
  });
}

export async function resetJobs(): Promise<void> {
  return withWriteLock(async () => {
    await ensureDir();
    await saveJobs([]);
    // Also clear backup to avoid stale recovery
    try { await fs.unlink(JOBS_BACKUP_FILE); } catch {}
    console.warn('[job-store] All jobs reset (cleared).');
  });
}

export async function deleteJob(id: string): Promise<boolean> {
  return withWriteLock(async () => {
    const jobs = await loadJobs();
    const idx = jobs.findIndex(j => j.id === id);
    if (idx === -1) return false;
    jobs.splice(idx, 1);
    await saveJobs(jobs);
    return true;
  });
}
