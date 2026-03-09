/**
 * attachment-downloader.ts — Shared Slack file download logic.
 *
 * Used by both live-sync (inline attachment ingestion) and backfill-attachments.
 */

import { getCookieString, getApiToken } from './session.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Download a Slack file using cookie + token auth.
 * Includes retry/backoff logic for rate limits and transient errors.
 *
 * @param url        - Private Slack download URL (url_private_download or url_private)
 * @param filename   - Filename for logging purposes
 * @param maxRetries - Number of retries (default: 3)
 * @returns          - File contents as a Buffer
 */
export async function downloadSlackFile(
  url: string,
  filename: string,
  maxRetries = 3
): Promise<Buffer> {
  const cookieString = getCookieString();
  const apiToken = getApiToken();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      };
      if (cookieString) headers['Cookie'] = cookieString;
      if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;

      const res = await fetch(url, { headers });

      if (res.status === 429) {
        const retryAfter = parseFloat(res.headers.get('retry-after') ?? '5');
        const waitMs = Math.ceil(retryAfter * 1000) + 500;
        console.log(`[attachment-downloader] Rate limited on ${filename}, waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`[attachment-downloader] ✓ Downloaded ${filename} (${buf.length} bytes)`);
      return buf;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `[attachment-downloader] Attempt ${attempt + 1}/${maxRetries + 1} failed for ${filename}: ${msg}`
      );
      if (attempt >= maxRetries) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }

  throw new Error(`Failed to download ${filename} after retries`);
}
