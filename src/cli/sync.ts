/**
 * CLI entry point for live Slack sync.
 * Usage: npm run sync -- <channel-id> [--oldest <ts>] [--latest <ts>] [--limit <n>]
 */
import 'dotenv/config';
import { loadSessionFromFile, hasSession } from '../lib/session.js';
import { syncCli } from '../commands/sync.js';

async function main() {
  const args = process.argv.slice(2);
  const channelId = args.find(a => !a.startsWith('--'));
  
  if (!channelId) {
    console.error('Usage: npm run sync -- <channel-id> [--oldest <ts>] [--latest <ts>] [--limit <n>]');
    console.error('');
    console.error('Arguments:');
    console.error('  <channel-id>     Slack channel or conversation ID (e.g. C0123456789)');
    console.error('  --oldest <ts>    Only fetch messages after this Slack timestamp');
    console.error('  --latest <ts>    Only fetch messages before this Slack timestamp');
    console.error('  --limit <n>      Max messages to fetch');
    console.error('');
    console.error('Examples:');
    console.error('  npm run sync -- C0123456789');
    console.error('  npm run sync -- C0123456789 --oldest 1677890123.456789');
    console.error('  npm run sync -- C0123456789 --limit 500');
    process.exit(1);
  }

  // Load session from file
  const loaded = await loadSessionFromFile();
  if (!loaded || !hasSession()) {
    console.error('Error: No Slack session found.');
    console.error('');
    console.error('Please start the server and log in first:');
    console.error('  npm run server');
    console.error('  Open http://localhost:3101/login');
    process.exit(1);
  }

  // Parse options
  const oldest = args[args.indexOf('--oldest') + 1];
  const latest = args[args.indexOf('--latest') + 1];
  const limitStr = args[args.indexOf('--limit') + 1];
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;

  await syncCli(channelId, {
    oldest: oldest || undefined,
    latest: latest || undefined,
    limit,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
