# openclaw-slack-ingestor

Ingests Slack messages into the OpenClaw Memory Database. Supports:
- **Browser-based login** — Chromium headless + CDP cookie capture (no API tokens needed)
- **Live sync** — Pull messages from any channel/DM via the Slack API
- **Scheduler** — Boundary-aligned recurring jobs with full history backfill
- **Web UI** at `/sync` — Manage jobs, run syncs, view recent runs
- **Dual write modes** — Memory Database API (preferred) or direct PostgreSQL fallback
- **Archive import** — Bulk import from a Slack export ZIP

---

## Quick Start

```bash
# Install dependencies
npm install

# Copy env template
cp .env.example .env
# Edit .env with your settings

# Start the server
npm run server
# → Login UI:  http://localhost:3101/login
# → Sync UI:   http://localhost:3101/sync
```

1. Open `http://localhost:3101/login` and click **Start Login**
2. Log into Slack in the browser that appears
3. Session is saved automatically to `.data/session/slack-session.json`
4. Go to `http://localhost:3101/sync` to sync channels

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MEMORY_DATABASE_API_URL` | — | Memory DB API base URL (enables API write mode) |
| `MEMORY_DATABASE_API_TOKEN` | — | Bearer token for the Memory DB API |
| `DATABASE_URL` | — | Direct PostgreSQL connection string (fallback when API vars not set) |
| `UI_TOKEN` | — | Optional auth token for the `/sync` UI. When set, the UI shows an auth modal |
| `LOGIN_SERVER_PORT` | `3101` | HTTP port for the server |
| `SCHEDULER_CONCURRENCY` | `1` | Max concurrent running jobs |
| `SCHEDULER_JOB_SPACING_MS` | `1000` | Minimum delay (ms) between jobs finishing |
| `SCHEDULE_SINCE_OVERLAP_PERCENT` | `10` | Overlap window for scheduled runs (avoids edge misses) |
| `DATA_DIR` | `.data/` | Root directory for jobs, runs, and session data |
| `NODE_ENV` | — | Set to `production` to use `/app/.data/` as default data root |

**Write mode precedence:**
1. **API mode** — when `MEMORY_DATABASE_API_URL` + `MEMORY_DATABASE_API_TOKEN` are both set
2. **PG mode** — fallback, requires `DATABASE_URL`

---

## Web UI — `/sync`

The sync UI provides a full management interface:

### Login Status Bar
Shows the current Slack session status (logged in / not logged in) with a link to the login page.

### Scheduler Queue Widget
Live view of the global job queue:
- Running and queued job counts
- Concurrency and spacing settings

### New Sync
Two modes:

**Manual Run** — Execute a one-off sync immediately:
- Channel ID (required)
- Since preset (1M, 5M, 1H, 1D, etc.) or explicit Oldest timestamp
- Optional Latest timestamp and Limit

**Scheduled Job** — Create a repeating job:
- Channel ID + Cadence (boundary-aligned: 1H, 1D, 1W, 1MO, etc.)
- Since window (defaults to cadence, e.g. hourly → fetch last 1 hour)
- Auto-generated name like `#general every 1H`

### Scheduled Jobs Table
Manage all scheduled jobs:
- **▶ Run** — Execute now (enqueues through global queue)
- **⟳ All** — Full history backfill (fetches from the beginning of time)
- **✏ Edit** — Edit name, channel, cadence, since preset, enabled state
- **Enable/Disable** — Toggle scheduling without deleting
- **✕ Delete** — Remove the job

### Recent Runs Table
Shows last 50 runs with:
- Started time, source (manual/scheduled), channel name + ID
- Status (queued/running/success/error)
- Since/Oldest parameter used
- Fetched, Inserted, Updated, Skipped, Attachments counts
- Duration and error message

### Optional Auth (`UI_TOKEN`)
If `UI_TOKEN` is set, the sync UI shows an auth modal on first visit. The token is stored in `localStorage` and sent as `Authorization: Bearer <token>`.

---

## Scheduler

### Cadence Presets (boundary-aligned UTC)
| Preset | Label | Boundary |
|---|---|---|
| `1m` | 1M | HH:MM:00 each minute |
| `5m` | 5M | minute % 5 == 0 |
| `15m` | 15M | :00/:15/:30/:45 each hour |
| `30m` | 30M | :00/:30 each hour |
| `1h` | 1H | top of each hour |
| `2h` | 2H | hour % 2 == 0 |
| `4h` | 4H | hour % 4 == 0 |
| `6h` | 6H | hour % 6 == 0 |
| `12h` | 12H | midnight & noon UTC |
| `1d` | 1D | midnight UTC |
| `1w` | 1W | Monday 00:00 UTC |
| `1mo` | 1MO | 1st of each month, 00:00 UTC |
| `1y` | 1Y | Jan 1, 00:00 UTC |

Jobs fire exactly at UTC boundaries — not "now + interval" — so they remain drift-free across restarts.

### Since Presets (lookback windows)
`1m`, `5m`, `15m`, `30m`, `1h`, `2h`, `4h`, `6h`, `12h`, `1d`, `3d`, `1w`, `2w`, `1mo`, `2mo`, `3mo`, `4mo`, `6mo`, `1y`, `3y`, `5y`, `10y`, `20y`, `all`

When a scheduled job runs, the `sincePreset` is resolved at runtime to a Slack Unix timestamp: `(now - presetMs) / 1000`. A 10% overlap window is applied to avoid missing messages at boundaries (configurable via `SCHEDULE_SINCE_OVERLAP_PERCENT`).

### Global FIFO Queue
All jobs (scheduled + manual) run through a single global queue:
- `SCHEDULER_CONCURRENCY=1` (default) serializes all work
- `SCHEDULER_JOB_SPACING_MS=1000` adds a 1s gap between jobs
- Duplicate job enqueues are silently dropped (per-job overlap guard)

### Data Persistence
- Jobs: `.data/jobs/jobs.json`
- Run history: `.data/runs/runs.json` (capped at 200 entries)
- Session: `.data/session/slack-session.json`

---

## API Reference

### Session

```
GET  /api/session/status  — { authenticated, team, user }
GET  /api/health          — { status, authenticated, team, user }
```

### Login

```
GET  /login                — Login UI (browser screencast)
POST /api/login/start      — Start Chromium login session
GET  /api/login/status     — { status, message, remainingMs }
POST /api/login/stop       — Stop login session
POST /api/logout           — Clear saved session
WS   /ws/login             — WebSocket for screencast + input
```

### Sync

```
POST /api/sync
Body: {
  channel: string,          // required: Slack channel ID
  sincePreset?: string,     // e.g. "1h", "1d", "all"
  oldest?: string,          // Slack Unix ts (overridden by sincePreset)
  latest?: string,          // Slack Unix ts upper bound
  limit?: number            // max messages to fetch
}
Response: { success, runId, channel, channelName, user, fetched, inserted, updated, skipped, attachmentsSeen }
```

### Jobs

```
GET    /api/jobs              — List all jobs
POST   /api/jobs              — Create job { channel, cadencePreset, sincePreset?, name?, enabled? }
PATCH  /api/jobs/:id          — Update job fields
DELETE /api/jobs/:id          — Delete job
POST   /api/jobs/:id/run      — Run now (enqueues)
POST   /api/jobs/:id/run-all  — Full history backfill
```

### Runs & Queue

```
GET /api/runs?limit=50       — Recent run history (newest first)
GET /api/scheduler/status    — Queue status { runningCount, queuedCount, concurrency, spacingMs }
```

---

## CLI Usage

### Live Sync (single run)

```bash
# Sync a channel (uses session from .data/session/)
npm run sync -- C0123456789

# With options
npm run sync -- C0123456789 --oldest 1677890123.456789
npm run sync -- C0123456789 --limit 500
npm run sync -- C0123456789 --oldest 1677890123 --latest 1677976523
```

### Archive Import

```bash
# Import from a Slack export ZIP (extracted)
npm run import -- --input /path/to/slack-export
npm run import -- --input /path/to/slack-export --dry-run
npm run import -- --input /path/to/slack-export --verbose
```

---

## Write Mode Details

### API Mode (preferred)
When `MEMORY_DATABASE_API_URL` + `MEMORY_DATABASE_API_TOKEN` are set, messages are written via:
```
POST /api/messages
{
  source: "slack",
  sender: "username",
  recipient: "#channel-name",
  content: "message text",
  timestamp: "2024-01-15T10:00:00.000Z",
  external_id: "C0123456789:1705312800.123456",
  metadata: { channelId, channelName, ts, userId, threadTs, ... }
}
```

**Retry/backoff:** Up to 3 retries on 429 (rate limit) and 5xx errors with exponential backoff. Reads `Retry-After` header on 429.

**Metrics:**
- `inserted` → HTTP 201 (new record)
- `updated` → HTTP 200 or 409 (existing record)
- `skipped` → unrecoverable errors

### PostgreSQL Mode (fallback)
When only `DATABASE_URL` is set, messages are upserted directly:
```sql
INSERT INTO messages (source_id, external_id, timestamp, sender, recipient, content, metadata)
VALUES (...)
ON CONFLICT (source_id, external_id) DO UPDATE SET ...
RETURNING xmax  -- 0 = inserted, non-0 = updated
```

---

## Docker

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["node", "dist/server.js"]
```

Environment variables needed at runtime:
- `MEMORY_DATABASE_API_URL` + `MEMORY_DATABASE_API_TOKEN` (or `DATABASE_URL`)
- `LOGIN_SERVER_PORT` (default 3101)
- `NODE_ENV=production` (uses `/app/.data/` for persistence)
- `UI_TOKEN` (optional)

---

## How Sessions Work

The ingestor captures Slack authentication cookies via a Chromium browser session:
1. Chromium launches with `--remote-debugging-port` enabled
2. The browser navigates to `https://slack.com/signin`
3. CDP (Chrome DevTools Protocol) monitors `Network.responseReceivedExtraInfo` events for `Set-Cookie` headers
4. When the `d` cookie (main Slack auth cookie) is captured, `auth.test` API is called to validate
5. Session is saved to `.data/session/slack-session.json` and loaded on server restart

The Slack API is then called using the captured cookies as `Cookie` headers — no API tokens or OAuth flows required.
