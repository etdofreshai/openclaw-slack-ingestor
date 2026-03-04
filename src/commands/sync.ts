/**
 * Live Slack sync command — fetches channel history and upserts to the
 * configured backend (API mode or direct PostgreSQL).
 *
 * Use via CLI: npm run sync -- <channel-id> [--oldest <ts>] [--limit <n>]
 * Or via server API: POST /api/sync
 */
import { syncSlackChannel } from '../lib/live-sync.js';
import type { SyncResult } from '../lib/live-sync.js';

export { syncSlackChannel };
export type { SyncResult };

/**
 * CLI entry point for sync command.
 */
export async function syncCli(
  channelId: string,
  options: { oldest?: string; latest?: string; limit?: number } = {}
): Promise<void> {
  try {
    const result = await syncSlackChannel(channelId, { ...options, verbose: true });
    console.log(JSON.stringify(result, null, 2));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
