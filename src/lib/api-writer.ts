/**
 * Memory Database API write module for Slack messages.
 *
 * Writes normalized Slack messages to the Memory Database API instead of
 * directly to PostgreSQL. Enabled when both MEMORY_DATABASE_API_URL and
 * MEMORY_DATABASE_API_TOKEN are set in the environment.
 *
 * Mode precedence:
 *   1. API mode  — MEMORY_DATABASE_API_URL + MEMORY_DATABASE_API_TOKEN both set
 *   2. PG mode   — fallback; DATABASE_URL required
 *
 * Metric caveats (API mode):
 *   - `inserted`  → HTTP 201 (Created) response from the API
 *   - `updated`   → HTTP 200 (OK) or 409 (Conflict) responses (existing record)
 *   - `skipped`   → unrecoverable errors (bad request, exhausted retries, etc.)
 *   - If the API always returns 200 for upserts (never 201), all successful
 *     writes will appear as `updated` and `inserted` will be 0. The sum
 *     inserted + updated + skipped always equals `fetched`.
 */

/** Maximum number of retries on transient failures (429, 5xx, network errors). */
const MAX_API_RETRIES = 3;
/** Initial exponential-backoff delay in milliseconds. */
const INITIAL_BACKOFF_MS = 1_000;

/**
 * Returns true when API mode is active:
 * both MEMORY_DATABASE_API_URL and MEMORY_DATABASE_API_TOKEN are set.
 */
export function isApiMode(): boolean {
  return !!(
    process.env.MEMORY_DATABASE_API_URL?.trim() &&
    process.env.MEMORY_DATABASE_API_TOKEN?.trim()
  );
}

/** Payload sent to POST /api/messages. */
export type ApiMessagePayload = {
  source: 'slack';
  sender: string;
  recipient: string;
  content: string;
  /** ISO 8601 timestamp string. */
  timestamp: string;
  external_id: string;
  metadata: Record<string, unknown>;
};

/** Write result for a single message — for internal use. */
type SingleWriteOutcome = 'inserted' | 'updated' | 'skipped';

/** Aggregate write result returned to callers. */
export type ApiWriteResult = {
  inserted: number;
  updated: number;
  skipped: number;
  attachmentsSeen: number;
};

/**
 * Write a single message to the API with retry/backoff.
 * Returns 'inserted', 'updated', or 'skipped'.
 */
async function writeOneMessage(
  baseUrl: string,
  token: string,
  payload: ApiMessagePayload
): Promise<SingleWriteOutcome> {
  for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
    let res: Response;

    try {
      res = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (err: unknown) {
      // Network-level error (ECONNREFUSED, DNS, timeout, etc.)
      if (attempt >= MAX_API_RETRIES) {
        console.error(
          `[api-writer] Network error for external_id=${payload.external_id} — ` +
            `exhausted ${MAX_API_RETRIES} retries:`,
          err
        );
        return 'skipped';
      }
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.warn(
        `[api-writer] Network error for external_id=${payload.external_id} — ` +
          `retry ${attempt + 1}/${MAX_API_RETRIES} in ${backoff}ms`
      );
      await sleep(backoff);
      continue;
    }

    // 429 — rate limited
    if (res.status === 429) {
      if (attempt >= MAX_API_RETRIES) {
        console.error(
          `[api-writer] 429 rate-limited for external_id=${payload.external_id} — ` +
            `exhausted ${MAX_API_RETRIES} retries`
        );
        return 'skipped';
      }
      const retryHeader =
        res.headers.get('retry-after') ?? res.headers.get('x-ratelimit-reset-after') ?? '5';
      const waitMs = Math.ceil((parseFloat(retryHeader) || 5) * 1_000) + 500;
      console.warn(
        `[api-writer] 429 rate-limited — external_id=${payload.external_id} ` +
          `retry-after=${retryHeader}s — waiting ${waitMs}ms before retry ${attempt + 1}/${MAX_API_RETRIES}`
      );
      await sleep(waitMs);
      continue;
    }

    // 5xx — transient server error
    if (res.status >= 500) {
      if (attempt >= MAX_API_RETRIES) {
        console.error(
          `[api-writer] API error ${res.status} for external_id=${payload.external_id} — ` +
            `exhausted ${MAX_API_RETRIES} retries`
        );
        return 'skipped';
      }
      const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.warn(
        `[api-writer] API error ${res.status} for external_id=${payload.external_id} — ` +
          `retry ${attempt + 1}/${MAX_API_RETRIES} in ${backoff}ms`
      );
      await sleep(backoff);
      continue;
    }

    // 201 Created — new record inserted
    if (res.status === 201) return 'inserted';

    // 200 OK — upsert returned existing record (treat as updated)
    if (res.status === 200) return 'updated';

    // 409 Conflict — already exists, treat as updated
    if (res.status === 409) return 'updated';

    // Other 4xx — unrecoverable (bad payload, auth failure, etc.)
    const body = await res.text().catch(() => '');
    console.error(
      `[api-writer] Unrecoverable API error ${res.status} for ` +
        `external_id=${payload.external_id}: ${body.slice(0, 200)}`
    );
    return 'skipped';
  }

  // Exhausted retry loop without resolving (should not reach here, but safe fallback)
  return 'skipped';
}

/**
 * Write a batch of normalized Slack messages to the Memory Database API.
 *
 * @param payloads     - Array of `{ payload, attachmentCount }` pairs to write.
 * @returns            - Aggregate result: inserted, updated, skipped, attachmentsSeen.
 */
export async function writeMessagesViaApi(
  payloads: Array<{ payload: ApiMessagePayload; attachmentCount: number }>
): Promise<ApiWriteResult> {
  const baseUrl = (process.env.MEMORY_DATABASE_API_URL ?? '').replace(/\/+$/, '');
  const token = process.env.MEMORY_DATABASE_API_TOKEN ?? '';

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let attachmentsSeen = 0;

  for (const { payload, attachmentCount } of payloads) {
    attachmentsSeen += attachmentCount;
    const outcome = await writeOneMessage(baseUrl, token, payload);
    if (outcome === 'inserted') inserted++;
    else if (outcome === 'updated') updated++;
    else skipped++;
  }

  return { inserted, updated, skipped, attachmentsSeen };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
