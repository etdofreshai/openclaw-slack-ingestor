# openclaw-slack-ingestor

Standalone Slack → OpenClaw memory DB ingestor.

Imports Slack export JSON files into the existing OpenClaw PostgreSQL `messages` table.

## Features

- Recursively scans Slack export folders
- Parses per-channel daily JSON message files
- Resolves user IDs via `users.json` when present
- Idempotent upsert via `(source_id, external_id)`
- Auto-creates `slack` source in `sources`
- `--dry-run` and `--verbose`

## Install

```bash
npm install
```

## Configure

Create `.env`:

```env
DATABASE_URL=postgresql://postgres:password@host:5432/postgres
```

## Run

```bash
npm run import -- --input /path/to/slack-export
```
