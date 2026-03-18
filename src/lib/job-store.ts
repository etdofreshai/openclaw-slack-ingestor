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

export async function loadJobs(): Promise<Job[]> {
  // Try main file first
  try {
    const raw = await fs.readFile(JOBS_FILE, 'utf8');
    return JSON.parse(raw) as Job[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // File doesn't exist yet, try backup
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[job-store] Failed to read/parse jobs from ${JOBS_FILE}: ${message}. Trying backup...`);
    }
  }

  // Try backup file
  try {
    const raw = await fs.readFile(JOBS_BACKUP_FILE, 'utf8');
    const jobs = JSON.parse(raw) as Job[];
    console.warn(`[job-store] Recovered ${jobs.length} jobs from backup file.`);
    return jobs;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[job-store] Failed to read/parse backup jobs from ${JOBS_BACKUP_FILE}: ${message}`);
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

  // Write backup before replacing main file (if main exists)
  try {
    await fs.copyFile(JOBS_FILE, JOBS_BACKUP_FILE);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      // Ignore ENOENT (no existing file), warn on other errors
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
