---
name: openclaw-slack-ingestor
description: Import Slack data into OpenClaw Postgres (export import + live web-session sync).
---

# openclaw-slack-ingestor

## Purpose
Ingest Slack messages into the OpenClaw `messages` table.

## Modes
- **Archive import**: Slack export folder (`channel/YYYY-MM-DD.json`)
- **Live sync**: web session capture + channel history pull

## Setup
```bash
npm install --include=dev
cp .env.example .env
```

Required env:
- `DATABASE_URL`

## Run
```bash
# Archive import
npm run import -- --input /path/to/slack-export [--dry-run] [--verbose]

# Start login/session server
npm run server

# Live sync
npm run sync -- --channel <CHANNEL_ID>
```

## Notes
- Idempotent upsert into `messages`
- Creates `slack` source automatically
- Re-login needed when session cookies expire
