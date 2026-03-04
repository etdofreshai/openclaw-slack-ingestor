/**
 * OpenClaw Slack Ingestor
 * 
 * Two modes:
 * 1. Archive import: npm run import -- --input /path/to/slack-export
 * 2. Live sync: npm run sync -- <channel-id>
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

// ── Types ────────────────────────────────────────────────────────────────────

type Cli = { input: string; dryRun: boolean; verbose: boolean };

type SlackUser = { id?: string; name?: string; profile?: { display_name?: string; real_name?: string } };
type SlackMessage = {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  subtype?: string;
  files?: unknown[];
  attachments?: unknown[];
  reactions?: unknown[];
  [k: string]: unknown;
};

type Normalized = {
  externalId: string;
  timestamp: Date;
  sender: string;
  recipient: string;
  content: string;
  metadata: Record<string, unknown>;
};

// ── CLI Parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Cli {
  const out: Cli = { input: '', dryRun: false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') out.input = argv[++i] ?? '';
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--verbose') out.verbose = true;
  }
  if (!out.input) {
    console.error('Usage: npm run import -- --input /path/to/slack-export [--dry-run] [--verbose]');
    process.exit(1);
  }
  return out;
}

// ── File Walking ─────────────────────────────────────────────────────────────

async function walkJson(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) out.push(p);
    }
  }
  await walk(root);
  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function tsToDate(ts: string): Date | null {
  const n = Number(ts);
  if (Number.isNaN(n)) return null;
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

function resolveSender(msg: SlackMessage, users: Map<string, string>): string {
  if (msg.user && users.has(msg.user)) return users.get(msg.user)!;
  return msg.username?.trim() || msg.user?.trim() || msg.bot_id?.trim() || 'unknown';
}

function normalize(msg: SlackMessage, channel: string, users: Map<string, string>): Normalized | null {
  const ts = msg.ts?.trim();
  if (!ts) return null;
  const timestamp = tsToDate(ts);
  if (!timestamp) return null;

  const externalId = `${channel}:${ts}`;
  const hasRich = (msg.files?.length ?? 0) > 0 || (msg.attachments?.length ?? 0) > 0;
  const content = msg.text?.trim() || (hasRich ? '[non-text slack message]' : '');
  if (!content && !hasRich) return null;

  return {
    externalId,
    timestamp,
    sender: resolveSender(msg, users),
    recipient: channel,
    content,
    metadata: {
      channel,
      thread_ts: msg.thread_ts ?? null,
      subtype: msg.subtype ?? null,
      files: msg.files ?? [],
      attachments: msg.attachments ?? [],
      reactions: msg.reactions ?? [],
      raw: msg,
    },
  };
}

async function loadUsers(root: string): Promise<Map<string, string>> {
  const file = path.join(root, 'users.json');
  const users = new Map<string, string>();
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as SlackUser[];
    if (Array.isArray(parsed)) {
      for (const u of parsed) {
        if (!u.id) continue;
        const name = u.profile?.display_name?.trim() || u.profile?.real_name?.trim() || u.name?.trim() || u.id;
        users.set(u.id, name);
      }
    }
  } catch {
    // optional
  }
  return users;
}

async function ensureSourceId(pool: pg.Pool): Promise<number> {
  const existing = await pool.query<{ id: number }>('SELECT id FROM sources WHERE name = $1 LIMIT 1', ['slack']);
  if (existing.rows[0]?.id) return existing.rows[0].id;
  const inserted = await pool.query<{ id: number }>('INSERT INTO sources (name) VALUES ($1) RETURNING id', ['slack']);
  return inserted.rows[0].id;
}

// ── Main Import ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cli = parseArgs(process.argv);
  const db = process.env.DATABASE_URL;
  if (!db && !cli.dryRun) {
    console.error('Missing DATABASE_URL');
    process.exit(1);
  }

  const users = await loadUsers(cli.input);
  const files = await walkJson(cli.input);

  let filesScanned = 0;
  let filesParsed = 0;
  let messagesSeen = 0;
  let skipped = 0;
  const normalized: Normalized[] = [];

  for (const filePath of files) {
    filesScanned++;
    const base = path.basename(filePath).toLowerCase();
    if (base === 'users.json') continue;

    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) continue;

      const channel = path.basename(path.dirname(filePath));
      filesParsed++;

      for (const m of parsed as SlackMessage[]) {
        messagesSeen++;
        const n = normalize(m, channel, users);
        if (!n) {
          skipped++;
          continue;
        }
        normalized.push(n);
      }

      if (cli.verbose) console.log(`Parsed ${filePath}: ${(parsed as SlackMessage[]).length} messages`);
    } catch (err) {
      skipped++;
      if (cli.verbose) console.warn(`Skipping ${filePath}:`, err);
    }
  }

  if (cli.dryRun) {
    console.log(JSON.stringify({ filesScanned, filesParsed, messagesSeen, normalized: normalized.length, skipped, dryRun: true }, null, 2));
    return;
  }

  const pool = new pg.Pool({ connectionString: db });
  try {
    const sourceId = await ensureSourceId(pool);
    let upserted = 0;
    for (const m of normalized) {
      const res = await pool.query(
        `INSERT INTO messages (source_id, external_id, timestamp, sender, recipient, content, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source_id, external_id)
         DO UPDATE SET
           timestamp = EXCLUDED.timestamp,
           sender = EXCLUDED.sender,
           recipient = EXCLUDED.recipient,
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata`,
        [sourceId, m.externalId, m.timestamp.toISOString(), m.sender, m.recipient, m.content, JSON.stringify(m.metadata)]
      );
      if ((res.rowCount ?? 0) > 0) upserted++;
    }

    console.log(JSON.stringify({ filesScanned, filesParsed, messagesSeen, normalized: normalized.length, skipped, upserted, sourceId, dryRun: false }, null, 2));
  } finally {
    await pool.end();
  }
}

// ── Entry Point ──────────────────────────────────────────────────────────────

// Check if this is an import command (has --input flag)
if (process.argv.includes('--input')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else if (process.argv[1]?.includes('index.ts') || process.argv[1]?.includes('index.js')) {
  // If run directly without --input, show usage
  console.error('Usage:');
  console.error('  Import archive: npm run import -- --input /path/to/slack-export');
  console.error('  Live sync:      npm run sync -- <channel-id>');
  console.error('  Server:         npm run server');
  process.exit(1);
}
