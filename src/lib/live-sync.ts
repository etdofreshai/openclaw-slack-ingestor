/**
 * live-sync.ts — Slack channel sync with API/PG write backends.
 *
 * Fetches all messages from a Slack channel using conversations.history with
 * cursor-based pagination, normalizes them, and writes to the configured backend:
 *
 *   API mode  (preferred): MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN
 *   PG mode   (fallback) : DATABASE_URL
 */
import pg from 'pg';
import { hasSession, getCookieString, getApiToken } from './session.js';
import { getUsername, getChannelInfo } from './slack-api.js';
import { isApiMode, writeMessagesViaApi, type ApiMessagePayload } from './api-writer.js';

const SLACK_API_BASE = 'https://slack.com/api';

/** Maximum number of retries on 429 / 5xx from Slack API. */
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1_000;

// ── Types ─────────────────────────────────────────────────────────────────────

type RawSlackMessage = {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  thread_ts?: string;
  subtype?: string;
  files?: unknown[];
  attachments?: unknown[];
  reactions?: Array<{ name: string; count: number }>;
  [k: string]: unknown;
};

export type Normalized = {
  externalId: string;
  timestamp: Date;
  sender: string;
  recipient: string;
  content: string;
  metadata: Record<string, unknown>;
  attachmentCount: number;
};

export interface SyncResult {
  fetched: number;
  inserted: number;
  updated: number;
  skipped: number;
  attachmentsSeen: number;
}

// ── Slack API fetch helpers ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch a single page of Slack conversations.history with retry/backoff.
 */
async function fetchPage(
  channelId: string,
  params: Record<string, string>
): Promise<{ messages: RawSlackMessage[]; hasMore: boolean; nextCursor?: string }> {
  const url = `${SLACK_API_BASE}/conversations.history`;
  const apiToken = getApiToken() || '';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;

    try {
      const body = new URLSearchParams({ token: apiToken, channel: channelId, ...params });
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Cookie: getCookieString(),
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });
    } catch (err: unknown) {
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
      continue;
    }

    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Slack rate-limited (429) for channel ${channelId} — retries exhausted`);
      }
      const retryHeader = res.headers.get('retry-after') ?? '5';
      const waitMs = Math.ceil((parseFloat(retryHeader) || 5) * 1000) + 500;
      console.warn(
        `[live-sync] 429 rate-limited — channel=${channelId} ` +
        `retry-after=${retryHeader}s — waiting ${waitMs}ms`
      );
      await sleep(waitMs);
      continue;
    }

    if (res.status >= 500) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Slack API server error ${res.status} for channel ${channelId}`);
      }
      await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
      continue;
    }

    if (!res.ok) {
      throw new Error(`Slack API HTTP ${res.status} for channel ${channelId}`);
    }

    const data = await res.json() as {
      ok: boolean;
      error?: string;
      messages?: RawSlackMessage[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };

    if (!data.ok) {
      if (data.error === 'ratelimited') {
        if (attempt >= MAX_RETRIES) throw new Error('Slack rate-limited — retries exhausted');
        await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
        continue;
      }
      throw new Error(`Slack API error: ${data.error}`);
    }

    return {
      messages: data.messages ?? [],
      hasMore: data.has_more ?? false,
      nextCursor: data.response_metadata?.next_cursor || undefined,
    };
  }

  throw new Error(`fetchPage: unexpected exit from retry loop (channel=${channelId})`);
}

/**
 * Fetch all messages from a Slack channel with cursor-based pagination.
 *
 * @param channelId - Slack channel/conversation ID
 * @param options.oldest - Only fetch messages after this Slack ts (exclusive lower bound)
 * @param options.latest - Only fetch messages before this Slack ts (exclusive upper bound)
 * @param options.limit  - Max total messages to fetch (default: unlimited)
 */
async function fetchAllMessages(
  channelId: string,
  options: { oldest?: string; latest?: string; limit?: number } = {}
): Promise<RawSlackMessage[]> {
  const maxMessages = options.limit ?? Number.MAX_SAFE_INTEGER;
  const allMessages: RawSlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = { limit: '200' };
    if (options.oldest) params.oldest = options.oldest;
    if (options.latest) params.latest = options.latest;
    if (cursor) params.cursor = cursor;

    const page = await fetchPage(channelId, params);

    for (const msg of page.messages) {
      allMessages.push(msg);
      if (allMessages.length >= maxMessages) {
        cursor = undefined;
        break;
      }
    }

    cursor = page.hasMore && allMessages.length < maxMessages ? page.nextCursor : undefined;
  } while (cursor);

  return allMessages;
}

/**
 * Fetch thread replies for a single parent message via conversations.replies.
 * Returns all reply messages (excluding the parent itself).
 */
async function fetchThreadReplies(
  channelId: string,
  threadTs: string,
): Promise<RawSlackMessage[]> {
  const apiToken = getApiToken() || '';
  const allReplies: RawSlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = { token: apiToken, channel: channelId, ts: threadTs, limit: '200' };
    if (cursor) params.cursor = cursor;

    const body = new URLSearchParams(params);

    let res: Response | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        res = await fetch(`${SLACK_API_BASE}/conversations.replies`, {
          method: 'POST',
          headers: {
            Cookie: getCookieString(),
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: body.toString(),
        });
      } catch (err) {
        if (attempt >= MAX_RETRIES) throw err;
        await sleep(INITIAL_BACKOFF_MS * Math.pow(2, attempt));
        continue;
      }

      if (res.status === 429) {
        if (attempt >= MAX_RETRIES) throw new Error(`429 rate-limited fetching thread ${threadTs}`);
        const retryAfter = res.headers.get('retry-after') ?? '5';
        await sleep(Math.ceil((parseFloat(retryAfter) || 5) * 1000) + 500);
        continue;
      }
      break;
    }

    if (!res || !res.ok) throw new Error(`Slack API HTTP ${res?.status} fetching thread ${threadTs}`);

    const data = await res.json() as {
      ok: boolean;
      error?: string;
      messages?: RawSlackMessage[];
      has_more?: boolean;
      response_metadata?: { next_cursor?: string };
    };

    if (!data.ok) throw new Error(`Slack API error fetching thread ${threadTs}: ${data.error}`);

    // Skip the first message (parent) — only collect replies
    for (const msg of data.messages ?? []) {
      if (msg.ts !== threadTs) {
        allReplies.push(msg);
      }
    }

    cursor = data.has_more ? data.response_metadata?.next_cursor : undefined;
  } while (cursor);

  return allReplies;
}

/**
 * For messages that are thread parents (have reply_count > 0),
 * fetch all thread replies and return them as additional messages.
 */
async function fetchAllThreadReplies(
  channelId: string,
  messages: RawSlackMessage[],
): Promise<RawSlackMessage[]> {
  const threadParents = messages.filter(
    m => m.thread_ts === m.ts && typeof m.reply_count === 'number' && (m.reply_count as number) > 0
  );

  if (threadParents.length === 0) return [];

  console.log(`[live-sync] Fetching replies for ${threadParents.length} threads in channel ${channelId}`);

  const allReplies: RawSlackMessage[] = [];
  for (const parent of threadParents) {
    try {
      const replies = await fetchThreadReplies(channelId, parent.ts as string);
      allReplies.push(...replies);
      if (replies.length > 0) {
        console.log(`[live-sync] Thread ${parent.ts}: ${replies.length} replies`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[live-sync] Failed to fetch replies for thread ${parent.ts}: ${msg}`);
    }
  }

  return allReplies;
}

// ── Normalization ─────────────────────────────────────────────────────────────

/** Get channel display name. Returns channelId if lookup fails. */
export async function fetchChannelName(channelId: string): Promise<string | null> {
  const info = await getChannelInfo(channelId).catch(() => ({}));
  return (info as { name?: string }).name ?? null;
}

/** Resolve a Slack message sender to a display name. */
async function resolveSender(msg: RawSlackMessage): Promise<string> {
  if (msg.user) {
    return getUsername(msg.user).catch(() => msg.user as string);
  }
  return msg.username?.trim() || (msg.bot_id as string | undefined)?.trim() || 'unknown';
}

/**
 * Normalize a raw Slack message into a canonical form.
 * Returns null for messages that should be skipped.
 */
async function normalizeMessage(
  msg: RawSlackMessage,
  channelId: string,
  channelName: string
): Promise<Normalized | null> {
  if (!msg.ts) return null;

  // Skip system events
  const subtype = msg.subtype as string | undefined;
  if (
    subtype === 'channel_join' ||
    subtype === 'channel_leave' ||
    subtype === 'channel_archive' ||
    subtype === 'channel_unarchive'
  ) {
    return null;
  }

  const files = Array.isArray(msg.files) ? msg.files : [];
  const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
  const attachmentCount = files.length + attachments.length;
  const hasRich = attachmentCount > 0;

  const content = (msg.text as string | undefined)?.trim() || (hasRich ? '[non-text slack message]' : '');
  if (!content) return null;

  const timestamp = new Date(parseFloat(msg.ts) * 1000);
  const sender = await resolveSender(msg);
  const externalId = `${channelId}:${msg.ts}`;

  return {
    externalId,
    timestamp,
    sender,
    recipient: `#${channelName}`,
    content,
    attachmentCount,
    metadata: {
      channelId,
      channelName,
      ts: msg.ts,
      userId: msg.user,
      botId: msg.bot_id,
      threadTs: msg.thread_ts,
      subtype: msg.subtype,
      files,
      attachments,
      reactions: Array.isArray(msg.reactions) ? msg.reactions : [],
    },
  };
}

// ── PostgreSQL write path ─────────────────────────────────────────────────────

async function ensureSourceId(pool: pg.Pool): Promise<number> {
  const existing = await pool.query<{ id: number }>(
    'SELECT id FROM sources WHERE name = $1 LIMIT 1',
    ['slack']
  );
  if (existing.rows[0]?.id) return existing.rows[0].id;
  const inserted = await pool.query<{ id: number }>(
    'INSERT INTO sources (name) VALUES ($1) RETURNING id',
    ['slack']
  );
  return inserted.rows[0].id;
}

async function writeToPostgres(
  pool: pg.Pool,
  normalized: Normalized[]
): Promise<{ inserted: number; updated: number; skipped: number; attachmentsSeen: number }> {
  const sourceId = await ensureSourceId(pool);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let attachmentsSeen = 0;

  for (const msg of normalized) {
    attachmentsSeen += msg.attachmentCount;

    const res = await pool.query<{ xmax: string }>(
      `INSERT INTO messages (source_id, external_id, timestamp, sender, recipient, content, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_id, external_id)
       DO UPDATE SET
         timestamp = EXCLUDED.timestamp,
         sender = EXCLUDED.sender,
         recipient = EXCLUDED.recipient,
         content = EXCLUDED.content,
         metadata = EXCLUDED.metadata
       RETURNING xmax`,
      [
        sourceId,
        msg.externalId,
        msg.timestamp.toISOString(),
        msg.sender,
        msg.recipient,
        msg.content,
        JSON.stringify(msg.metadata),
      ]
    );

    if ((res.rowCount ?? 0) > 0) {
      if (res.rows[0].xmax === '0') inserted++;
      else updated++;
    } else {
      skipped++;
    }
  }

  return { inserted, updated, skipped, attachmentsSeen };
}

// ── Main sync entry point ─────────────────────────────────────────────────────

/**
 * Unified Slack channel sync: fetch messages and write to the configured backend.
 *
 * Write mode is selected automatically:
 *   - API mode (preferred): MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN
 *   - PG mode (fallback):   DATABASE_URL
 *
 * @param channelId - Slack channel/conversation ID
 * @param options.oldest  - Fetch messages after this Slack Unix timestamp
 * @param options.latest  - Fetch messages before this Slack Unix timestamp
 * @param options.limit   - Max messages to fetch
 * @param options.verbose - Log sync stats
 */
export async function syncSlackChannel(
  channelId: string,
  options?: {
    oldest?: string;
    latest?: string;
    limit?: number;
    verbose?: boolean;
  }
): Promise<SyncResult> {
  if (!hasSession()) {
    throw new Error('No active Slack session. Please log in first.');
  }

  // Resolve channel name for recipient field
  const channelName = (await fetchChannelName(channelId).catch(() => null)) ?? channelId;

  // Fetch all raw messages
  const rawMessages = await fetchAllMessages(channelId, {
    oldest: options?.oldest,
    latest: options?.latest,
    limit: options?.limit,
  });

  // Fetch thread replies for any parent messages
  const threadReplies = await fetchAllThreadReplies(channelId, rawMessages);
  const allMessages = [...rawMessages, ...threadReplies];

  // Normalize messages (resolves sender names via API)
  const normalized: Normalized[] = [];
  for (const msg of allMessages) {
    const n = await normalizeMessage(msg, channelId, channelName);
    if (n) normalized.push(n);
  }

  let result: SyncResult;

  if (isApiMode()) {
    // ── API write mode ──────────────────────────────────────────────────────
    const inputs = normalized.map(msg => ({
      payload: {
        source: 'slack' as const,
        sender: msg.sender,
        recipient: msg.recipient,
        content: msg.content,
        timestamp: msg.timestamp.toISOString(),
        external_id: msg.externalId,
        metadata: msg.metadata,
      } satisfies ApiMessagePayload,
      attachmentCount: msg.attachmentCount,
    }));

    const writeResult = await writeMessagesViaApi(inputs);
    result = { fetched: allMessages.length, ...writeResult };
  } else {
    // ── PostgreSQL write mode ───────────────────────────────────────────────
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not configured and API mode ' +
        '(MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN) is not active.'
      );
    }

    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      const writeResult = await writeToPostgres(pool, normalized);
      result = { fetched: allMessages.length, ...writeResult };
    } finally {
      await pool.end();
    }
  }

  if (options?.verbose) {
    const mode = isApiMode() ? 'api' : 'pg';
    console.log(
      `[live-sync] Slack ${channelId} [${mode}]: fetched=${result.fetched}, ` +
      `inserted=${result.inserted}, updated=${result.updated}, ` +
      `skipped=${result.skipped}, attachmentsSeen=${result.attachmentsSeen}`
    );
  }

  return result;
}
