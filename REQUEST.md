# REQUEST.md — openclaw-slack-ingestor

## Goal
Ingest Slack message history into the OpenClaw PostgreSQL messages database as a standalone repo/service.

## Input Source (v1)
Primary input is Slack export archives extracted to a local directory.

Expected export structure:
- Workspace export root
- Per-channel folders (e.g. `general/`)
- Per-day JSON files (`YYYY-MM-DD.json`) containing arrays of message objects

Common Slack message fields:
- `ts` (Slack timestamp string)
- `user` or `bot_id`
- `text`
- `files`, `attachments`, `reactions`, `thread_ts`

Optional user lookup file:
- `users.json` at export root for mapping user IDs to names

## Stack
- TypeScript + Node.js
- PostgreSQL (`pg`)
- CLI importer script

## Database Target
Insert/upsert into existing `messages` table:
- `source_id` = source row for `slack` (auto-create in `sources` if missing)
- `external_id` = `<channel>:<ts>`
- `sender` = resolved Slack username/display name (fallback user/bot id)
- `recipient` = channel name
- `content` = Slack text (or placeholder for non-text)
- `timestamp` = parsed from `ts`
- `metadata` = raw useful JSON (channel, thread, files, attachments, reactions, subtype)

## Behavior
- Recursively discover channel/day JSON files under `--input`
- Skip malformed/non-message files with warnings
- Parse and normalize message records
- Upsert idempotently by `(source_id, external_id)`
- Print summary: files scanned, messages seen, upserted, skipped

## CLI
```bash
npm run import -- --input /path/to/slack-export
```

Optional flags:
- `--dry-run`
- `--verbose`

## Environment Variables
```env
DATABASE_URL=postgresql://postgres:password@host:5432/postgres
```

## Notes
- v1 is archive-import focused (reliable and simple)
- Future v2 can add Slack Web API incremental sync with watermarks
