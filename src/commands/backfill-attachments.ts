import 'dotenv/config';
import { randomUUID } from 'crypto';
import { getApiToken, hasSession, getCookieString } from '../lib/session.js';
import { downloadSlackFile } from '../lib/attachment-downloader.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type BackfillMode = 'memory-db' | 'slack-api';

export type BackfillOptions = {
  batchSize: number;
  limit?: number;
  dryRun: boolean;
  resumeFrom: number;
  mode: BackfillMode;
  attachmentMode: 'missing' | 'force';
};

export type BackfillStats = {
  messagesProcessed: number;
  messagesWithAttachments: number;
  totalAttachmentsFetched: number;
  attachmentsDownloaded: number;
  attachmentsIngested: number;
  attachmentsSkipped: number;
  errors: Array<{ message: string; attachmentUrl?: string; messageId?: string }>;
};

export type BackfillProgress = {
  runId: string;
  page: number;
  totalPages: number;
  messagesProcessed: number;
  downloadedCount: number;
  ingestedCount: number;
  skippedCount: number;
  errorCount: number;
  lastEvent?: string;
  startTime: Date;
  currentTime: Date;
  estimatedRemaining?: number;
  recentItems?: Array<{
    filename: string;
    status: 'downloaded' | 'ingested' | 'skipped' | 'error';
    messageId: string;
    size?: number;
  }>;
};

export type ProgressCallback = (progress: BackfillProgress) => void;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function hasExistingAttachments(apiUrl: string, token: string, recordId: string): Promise<boolean> {
  try {
    const res = await fetch(`${apiUrl}/api/messages/${recordId}/attachments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const data = await res.json() as unknown[] | { attachments?: unknown[] };
    const list = Array.isArray(data) ? data : (data.attachments ?? []);
    return list.length > 0;
  } catch { return false; }
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Ingest an attachment via Memory DB API.
 */
async function ingestAttachment(
  apiUrl: string,
  token: string,
  messageData: {
    external_id: string;
    sender: string;
    recipient: string;
    content: string;
    timestamp: string;
    metadata: unknown;
  },
  fileBuffer: Buffer,
  attachmentMeta: {
    id: string;
    filename: string;
    size: number;
    content_type?: string;
    created_at_source?: string;
  }
): Promise<boolean> {
  console.log(
    `[backfill-ingest] Ingesting ${attachmentMeta.filename} (${fileBuffer.length} bytes) ` +
    `for message ${messageData.external_id}`
  );

  const messagePayload = {
    source: 'slack',
    sender: messageData.sender,
    recipient: messageData.recipient,
    content: messageData.content,
    timestamp: messageData.timestamp,
    external_id: messageData.external_id,
    metadata: messageData.metadata,
  };

  const attachmentsMeta = [
    {
      original_file_name: attachmentMeta.filename,
      created_at_source: attachmentMeta.created_at_source,
    },
  ];

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      // Recreate FormData each attempt (don't reuse)
      const form = new FormData();
      form.append('message', JSON.stringify(messagePayload));
      form.append('files', new Blob([new Uint8Array(fileBuffer)], {
        type: attachmentMeta.content_type || 'application/octet-stream',
      }), attachmentMeta.filename);
      form.append('attachments_meta', JSON.stringify(attachmentsMeta));

      const url = `${apiUrl}/api/messages/ingest`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'openclaw-slack-ingestor/1.0',
        },
        body: form,
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        console.warn(`[backfill-ingest] 429 rate limit, waiting ${waitMs}ms (attempt ${attempt + 1}/4)`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`API returned ${res.status}: ${body.slice(0, 500)}`);
      }

      console.log(`[backfill-ingest] ✓ Successfully ingested ${attachmentMeta.filename}`);
      return true;
    } catch (err: any) {
      if (attempt >= 3) throw err;
      const backoff = 1000 * Math.pow(2, attempt);
      console.warn(`[backfill-ingest] Error on attempt ${attempt + 1}, retrying in ${backoff}ms: ${err.message}`);
      await sleep(backoff);
    }
  }

  throw new Error('Failed to ingest attachment after retries');
}

// ── Memory DB Mode ────────────────────────────────────────────────────────────

interface SlackMessageFromDB {
  id: string;
  external_id: string;
  sender: string;
  recipient: string;
  content: string;
  timestamp: string;
  record_id: string;
  metadata: {
    files?: Array<{
      id: string;
      name: string;
      filetype?: string;
      size?: number;
      url_private?: string;
      url_private_download?: string;
      mimetype?: string;
    }>;
    channelId?: string;
    [key: string]: unknown;
  };
}

async function fetchSlackMessagesFromDB(
  apiUrl: string,
  token: string,
  page: number,
  limit = 100
): Promise<{ messages: SlackMessageFromDB[]; total: number; totalPages: number }> {
  const url = `${apiUrl}/api/messages?source=slack&limit=${limit}&page=${page}`;

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'openclaw-slack-ingestor/1.0',
        },
      });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        await sleep(Math.ceil(retryAfter * 1000) + 500);
        continue;
      }

      if (!res.ok) throw new Error(`API returned ${res.status}: ${res.statusText}`);

      const data = (await res.json()) as { messages?: SlackMessageFromDB[]; total?: number; totalPages?: number };
      return {
        messages: data.messages || [],
        total: data.total || 0,
        totalPages: data.totalPages || 1,
      };
    } catch (err) {
      if (attempt >= 3) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw new Error(`Failed to fetch page ${page} after retries`);
}

// ── Slack API Mode ────────────────────────────────────────────────────────────

async function slackApiPost(endpoint: string, params: Record<string, string>): Promise<any> {
  const apiToken = getApiToken();
  const cookieString = getCookieString();

  if (!apiToken) throw new Error('No Slack API token available. Please log in first.');

  const body = new URLSearchParams({ ...params, token: apiToken });
  const res = await fetch(`https://slack.com/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieString,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`Slack API HTTP ${res.status}: ${res.statusText}`);
  const data = await res.json() as { ok: boolean; error?: string; [key: string]: unknown };
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
  return data;
}

async function* fetchSlackChannels(): AsyncGenerator<{ id: string; name: string }> {
  let cursor = '';
  do {
    const params: Record<string, string> = { limit: '200', types: 'public_channel,private_channel' };
    if (cursor) params.cursor = cursor;

    const data = await slackApiPost('conversations.list', params);
    const channels = (data.channels || []) as Array<{ id: string; name: string }>;
    for (const ch of channels) yield ch;

    cursor = (data.response_metadata as { next_cursor?: string })?.next_cursor || '';
    if (cursor) await sleep(500); // rate limit
  } while (cursor);
}

interface SlackFileInfo {
  id: string;
  name: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  mimetype?: string;
}

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  files?: SlackFileInfo[];
  attachments?: unknown[];
  subtype?: string;
}

async function* fetchChannelMessagesWithFiles(
  channelId: string,
  channelName: string
): AsyncGenerator<{ msg: SlackMessage; channelId: string; channelName: string }> {
  let cursor = '';
  do {
    const params: Record<string, string> = { channel: channelId, limit: '200' };
    if (cursor) params.cursor = cursor;

    let data: any;
    try {
      data = await slackApiPost('conversations.history', params);
    } catch (err: any) {
      console.warn(`[backfill] Skipping channel ${channelName}: ${err.message}`);
      return;
    }

    const messages = (data.messages || []) as SlackMessage[];
    for (const msg of messages) {
      if (msg.files && msg.files.length > 0) {
        yield { msg, channelId, channelName };
      }
    }

    cursor = (data.response_metadata as { next_cursor?: string })?.next_cursor || '';
    if (cursor) await sleep(300);
  } while (cursor);
}

// ── Main Backfill Function ────────────────────────────────────────────────────

export async function backfillAttachments(
  options: BackfillOptions,
  progressCallback?: ProgressCallback
): Promise<BackfillStats> {
  const apiUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const readToken = process.env.MEMORY_DATABASE_API_TOKEN ?? '';
  const writeToken = process.env.MEMORY_DATABASE_API_WRITE_TOKEN ?? readToken;

  if (!apiUrl || !readToken) {
    throw new Error('Missing MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_TOKEN');
  }

  const stats: BackfillStats = {
    messagesProcessed: 0,
    messagesWithAttachments: 0,
    totalAttachmentsFetched: 0,
    attachmentsDownloaded: 0,
    attachmentsIngested: 0,
    attachmentsSkipped: 0,
    errors: [],
  };

  const runId = randomUUID();
  const startTime = new Date();
  const recentItems: BackfillProgress['recentItems'] = [];

  function addRecentItem(item: NonNullable<BackfillProgress['recentItems']>[number]): void {
    recentItems!.push(item);
    if (recentItems!.length > 10) recentItems!.shift();
  }

  async function processFile(
    file: SlackFileInfo,
    messageData: {
      external_id: string;
      sender: string;
      recipient: string;
      content: string;
      timestamp: string;
      metadata: unknown;
    }
  ): Promise<void> {
    const downloadUrl = file.url_private_download || file.url_private;
    if (!downloadUrl) {
      console.warn(`[backfill] No download URL for file ${file.name} in ${messageData.external_id}`);
      stats.attachmentsSkipped++;
      addRecentItem({ filename: file.name, status: 'skipped', messageId: messageData.external_id, size: file.size });
      return;
    }

    try {
      const fileBuffer = await downloadSlackFile(downloadUrl, file.name);
      stats.attachmentsDownloaded++;
      addRecentItem({ filename: file.name, status: 'downloaded', messageId: messageData.external_id, size: file.size });

      if (options.dryRun) return;

      await ingestAttachment(apiUrl, writeToken, messageData, fileBuffer, {
        id: file.id,
        filename: file.name,
        size: file.size || fileBuffer.length,
        content_type: file.mimetype || 'application/octet-stream',
        created_at_source: messageData.timestamp,
      });
      stats.attachmentsIngested++;
      addRecentItem({ filename: file.name, status: 'ingested', messageId: messageData.external_id, size: file.size });
    } catch (err: any) {
      stats.attachmentsSkipped++;
      const errorMsg = String(err?.message ?? 'Unknown error');
      console.error(`[backfill] Error processing ${file.name} (${messageData.external_id}): ${errorMsg}`);
      addRecentItem({ filename: file.name, status: 'error', messageId: messageData.external_id, size: file.size });
      stats.errors.push({ message: errorMsg, attachmentUrl: downloadUrl, messageId: messageData.external_id });
    }
  }

  if (options.mode === 'memory-db') {
    // ── Mode 1: From Memory DB ──────────────────────────────────────────────
    const firstPage = await fetchSlackMessagesFromDB(apiUrl, readToken, 1, 100);
    const totalPages = firstPage.totalPages;
    const maxMessages = options.limit ?? firstPage.total;
    const startPage = options.resumeFrom ?? 1;
    let messagesProcessedTotal = 0;

    for (let page = startPage; page <= totalPages && messagesProcessedTotal < maxMessages; page++) {
      const pageData = page === 1 ? firstPage : await fetchSlackMessagesFromDB(apiUrl, readToken, page, 100);

      for (const message of pageData.messages) {
        if (messagesProcessedTotal >= maxMessages) break;
        stats.messagesProcessed++;
        messagesProcessedTotal++;

        const files = message.metadata?.files ?? [];
        if (files.length === 0) continue;

        if (options.attachmentMode === 'missing') {
          const hasAttachments = await hasExistingAttachments(apiUrl, readToken, message.record_id);
          if (hasAttachments) {
            stats.attachmentsSkipped += files.length;
            addRecentItem({ filename: `[skipped] ${message.external_id}`, status: 'skipped', messageId: message.external_id });
            continue;
          }
        }

        stats.messagesWithAttachments++;
        stats.totalAttachmentsFetched += files.length;

        const messageData = {
          external_id: message.external_id,
          sender: message.sender,
          recipient: message.recipient,
          content: message.content,
          timestamp: message.timestamp,
          metadata: message.metadata,
        };

        for (let i = 0; i < files.length; i += options.batchSize) {
          const batch = files.slice(i, i + options.batchSize);
          await Promise.all(batch.map(file => processFile(file, messageData)));
        }
      }

      const now = new Date();
      const elapsed = now.getTime() - startTime.getTime();
      const pagesPerMs = page / elapsed;
      const remainingPages = totalPages - page;
      const estimatedRemaining = pagesPerMs > 0 ? remainingPages / pagesPerMs : undefined;

      progressCallback?.({
        runId,
        page,
        totalPages,
        messagesProcessed: stats.messagesProcessed,
        downloadedCount: stats.attachmentsDownloaded,
        ingestedCount: stats.attachmentsIngested,
        skippedCount: stats.attachmentsSkipped,
        errorCount: stats.errors.length,
        lastEvent: `Page ${page}/${totalPages}: ${stats.attachmentsDownloaded} downloaded, ${stats.attachmentsIngested} ingested`,
        startTime,
        currentTime: now,
        estimatedRemaining: remainingPages > 0 ? estimatedRemaining : 0,
        recentItems: [...recentItems],
      });
    }
  } else {
    // ── Mode 2: From Slack API ──────────────────────────────────────────────
    if (!hasSession()) {
      throw new Error('No Slack session. Please log in via /login first.');
    }

    const maxMessages = options.limit ?? Infinity;
    let channelCount = 0;
    let totalChannels = 0;

    // First, count channels (approximate)
    const channelList: Array<{ id: string; name: string }> = [];
    for await (const ch of fetchSlackChannels()) {
      channelList.push(ch);
    }
    totalChannels = channelList.length;
    console.log(`[backfill] Found ${totalChannels} channels to scan`);

    for (const channel of channelList) {
      if (stats.messagesProcessed >= maxMessages) break;
      channelCount++;
      console.log(`[backfill] Scanning #${channel.name} (${channelCount}/${totalChannels})`);

      for await (const { msg, channelId } of fetchChannelMessagesWithFiles(channel.id, channel.name)) {
        if (stats.messagesProcessed >= maxMessages) break;

        stats.messagesProcessed++;

        const externalId = `${channelId}:${msg.ts}`;
        const sender = msg.user || msg.bot_id || msg.username || 'unknown';
        const recipient = `slack-channel:${channelId}`;
        const content = msg.text || '[message with files]';
        // Convert Slack ts to ISO timestamp
        const tsNum = parseFloat(msg.ts);
        const timestamp = new Date(tsNum * 1000).toISOString();

        const metadata = {
          channelId,
          channelName: channel.name,
          ts: msg.ts,
          user: msg.user,
          bot_id: msg.bot_id,
          files: msg.files,
          attachments: msg.attachments,
        };

        const files = msg.files ?? [];

        if (options.attachmentMode === 'missing') {
          // For slack-api mode, we check by external_id — fetch the message record_id from the DB first
          // We skip if any existing attachments are found for this external_id
          const searchRes = await fetch(`${apiUrl}/api/messages?source=slack&external_id=${encodeURIComponent(externalId)}&limit=1`, {
            headers: { Authorization: `Bearer ${readToken}` },
          }).catch(() => null);
          if (searchRes?.ok) {
            const searchData = await searchRes.json() as { messages?: Array<{ record_id: string }> };
            const recordId = searchData?.messages?.[0]?.record_id;
            if (recordId) {
              const hasAttachments = await hasExistingAttachments(apiUrl, readToken, recordId);
              if (hasAttachments) {
                stats.attachmentsSkipped += files.length;
                addRecentItem({ filename: `[skipped] ${externalId}`, status: 'skipped', messageId: externalId });
                continue;
              }
            }
          }
        }

        stats.messagesWithAttachments++;
        stats.totalAttachmentsFetched += files.length;

        const messageData = { external_id: externalId, sender, recipient, content, timestamp, metadata };

        for (let i = 0; i < files.length; i += options.batchSize) {
          const batch = files.slice(i, i + options.batchSize);
          await Promise.all(batch.map(file => processFile(file, messageData)));
        }

        const now = new Date();
        progressCallback?.({
          runId,
          page: channelCount,
          totalPages: totalChannels,
          messagesProcessed: stats.messagesProcessed,
          downloadedCount: stats.attachmentsDownloaded,
          ingestedCount: stats.attachmentsIngested,
          skippedCount: stats.attachmentsSkipped,
          errorCount: stats.errors.length,
          lastEvent: `#${channel.name}: processed ${externalId}`,
          startTime,
          currentTime: now,
          recentItems: [...recentItems],
        });
      }

      // Emit per-channel progress
      const now = new Date();
      const elapsed = now.getTime() - startTime.getTime();
      const channelsPerMs = channelCount / elapsed;
      const remaining = totalChannels - channelCount;
      progressCallback?.({
        runId,
        page: channelCount,
        totalPages: totalChannels,
        messagesProcessed: stats.messagesProcessed,
        downloadedCount: stats.attachmentsDownloaded,
        ingestedCount: stats.attachmentsIngested,
        skippedCount: stats.attachmentsSkipped,
        errorCount: stats.errors.length,
        lastEvent: `Done #${channel.name} (${channelCount}/${totalChannels}): ${stats.attachmentsIngested} ingested total`,
        startTime,
        currentTime: now,
        estimatedRemaining: channelsPerMs > 0 && remaining > 0 ? remaining / channelsPerMs : 0,
        recentItems: [...recentItems],
      });
    }
  }

  return stats;
}
