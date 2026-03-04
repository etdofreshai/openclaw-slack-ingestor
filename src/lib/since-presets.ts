/**
 * since-presets.ts
 *
 * Relative lookback window presets for Slack sync.
 * CADENCE_PRESETS are the scheduling frequency subset — all boundary-aligned to UTC.
 *
 * Precedence rule: sincePreset overrides explicit `oldest` when both are set.
 * The effective `oldest` Slack timestamp is computed at runtime from `now - presetMs`.
 *
 * ── Boundary alignment rules (UTC) ─────────────────────────────────────────
 *   1m   → top of each minute  (HH:MM:00)
 *   5m   → minute % 5 == 0    (:00/:05/:10/…)
 *   15m  → minute % 15 == 0   (:00/:15/:30/:45)
 *   30m  → :00/:30 each hour
 *   1h   → top of each hour
 *   2h   → hour % 2 == 0
 *   4h   → hour % 4 == 0
 *   6h   → hour % 6 == 0
 *   12h  → midnight and noon UTC
 *   1d   → midnight UTC (day-aligned from Unix epoch)
 *   3d   → every 3rd day from Unix epoch, midnight UTC
 *   1w   → Monday 00:00 UTC
 *   2w   → biweekly Monday 00:00 UTC (anchored to 1970-01-05)
 *   1mo  → 1st of each calendar month, 00:00 UTC
 *   2mo  → 1st of Jan/Mar/May/Jul/Sep/Nov, 00:00 UTC
 *   3mo  → 1st of each quarter (Jan/Apr/Jul/Oct), 00:00 UTC
 *   4mo  → 1st of Jan/May/Sep, 00:00 UTC
 *   6mo  → 1st of Jan/Jul, 00:00 UTC
 *   1y   → Jan 1, 00:00 UTC
 */

// ── Since presets (lookback windows) ────────────────────────────────────────

export const SINCE_PRESETS = [
  '1m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '12h',
  '1d', '3d',
  '1w', '2w',
  '1mo', '2mo', '3mo', '4mo', '6mo',
  '1y', '3y', '5y', '10y', '20y',
  'all',
] as const;

export type SincePreset = typeof SINCE_PRESETS[number];

export const SINCE_PRESET_LABELS: Record<SincePreset, string> = {
  '1m': '1 minute',
  '5m': '5 minutes',
  '15m': '15 minutes',
  '30m': '30 minutes',
  '1h': '1 hour',
  '2h': '2 hours',
  '4h': '4 hours',
  '6h': '6 hours',
  '12h': '12 hours',
  '1d': '1 day',
  '3d': '3 days',
  '1w': '1 week',
  '2w': '2 weeks',
  '1mo': '1 month',
  '2mo': '2 months',
  '3mo': '3 months',
  '4mo': '4 months',
  '6mo': '6 months',
  '1y': '1 year',
  '3y': '3 years',
  '5y': '5 years',
  '10y': '10 years',
  '20y': '20 years',
  'all': 'All time',
};

// ── Cadence presets (scheduling frequency) ──────────────────────────────────

/**
 * Scheduling cadence presets.
 * Each preset is boundary-aligned in UTC — see module doc for alignment rules.
 * All cadence values are also valid SincePreset values (CadencePreset ⊆ SincePreset).
 */
export const CADENCE_PRESETS = [
  '1m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '12h',
  '1d', '3d',
  '1w', '2w',
  '1mo', '2mo', '3mo', '4mo', '6mo',
  '1y',
] as const;

export type CadencePreset = typeof CADENCE_PRESETS[number];

export const CADENCE_PRESET_LABELS: Record<CadencePreset, string> = {
  '1m': 'Every 1 minute',
  '5m': 'Every 5 minutes',
  '15m': 'Every 15 minutes',
  '30m': 'Every 30 minutes',
  '1h': 'Every 1 hour',
  '2h': 'Every 2 hours',
  '4h': 'Every 4 hours',
  '6h': 'Every 6 hours',
  '12h': 'Every 12 hours',
  '1d': 'Every day',
  '3d': 'Every 3 days',
  '1w': 'Every week',
  '2w': 'Every 2 weeks',
  '1mo': 'Every month',
  '2mo': 'Every 2 months',
  '3mo': 'Every quarter',
  '4mo': 'Every 4 months',
  '6mo': 'Every 6 months',
  '1y': 'Every year',
};

/** Human-readable boundary description shown in the UI. */
export const CADENCE_BOUNDARY_LABELS: Record<CadencePreset, string> = {
  '1m': 'HH:MM:00 each minute (UTC)',
  '5m': 'minute % 5 == 0 (UTC)',
  '15m': ':00/:15/:30/:45 each hour (UTC)',
  '30m': ':00/:30 each hour (UTC)',
  '1h': 'top of each hour (UTC)',
  '2h': 'hour % 2 == 0 (UTC)',
  '4h': 'hour % 4 == 0 (UTC)',
  '6h': 'hour % 6 == 0 (UTC)',
  '12h': 'midnight & noon UTC',
  '1d': 'midnight UTC',
  '3d': 'every 3rd day from Unix epoch, midnight UTC',
  '1w': 'Monday 00:00 UTC',
  '2w': 'biweekly Monday 00:00 UTC',
  '1mo': '1st of each month, 00:00 UTC',
  '2mo': '1st of Jan/Mar/May/Jul/Sep/Nov, 00:00 UTC',
  '3mo': '1st of each quarter (Jan/Apr/Jul/Oct), 00:00 UTC',
  '4mo': '1st of Jan/May/Sep, 00:00 UTC',
  '6mo': '1st of Jan/Jul, 00:00 UTC',
  '1y': 'Jan 1, 00:00 UTC',
};

/**
 * Derived intervalMinutes for each cadence preset.
 * Stored in Job.intervalMinutes for backward compatibility.
 * Monthly/yearly values are approximate — boundary alignment drives actual scheduling.
 */
export const CADENCE_PRESET_MINUTES: Record<CadencePreset, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '6h': 360,
  '12h': 720,
  '1d': 1440,
  '3d': 4320,
  '1w': 10080,
  '2w': 20160,
  '1mo': 43200,
  '2mo': 86400,
  '3mo': 129600,
  '4mo': 172800,
  '6mo': 259200,
  '1y': 525960,
};

export function isCadencePreset(value: unknown): value is CadencePreset {
  return typeof value === 'string' && (CADENCE_PRESETS as readonly string[]).includes(value);
}

// ── Since preset utilities ──────────────────────────────────────────────────

/** Milliseconds for each preset. Months/year use calendar approximations. */
export function sincePresetToMs(preset: SincePreset): number {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  switch (preset) {
    case '1m':   return MINUTE;
    case '5m':   return 5 * MINUTE;
    case '15m':  return 15 * MINUTE;
    case '30m':  return 30 * MINUTE;
    case '1h':   return HOUR;
    case '2h':   return 2 * HOUR;
    case '4h':   return 4 * HOUR;
    case '6h':   return 6 * HOUR;
    case '12h':  return 12 * HOUR;
    case '1d':   return DAY;
    case '3d':   return 3 * DAY;
    case '1w':   return 7 * DAY;
    case '2w':   return 14 * DAY;
    case '1mo':  return 30 * DAY;
    case '2mo':  return 60 * DAY;
    case '3mo':  return 90 * DAY;
    case '4mo':  return 120 * DAY;
    case '6mo':  return 180 * DAY;
    case '1y':   return 365 * DAY;
    case '3y':   return 3 * 365 * DAY;
    case '5y':   return 5 * 365 * DAY;
    case '10y':  return 10 * 365 * DAY;
    case '20y':  return 20 * 365 * DAY;
    case 'all':  return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Convert a Unix timestamp (ms) to a Slack timestamp string.
 * Slack timestamps are Unix seconds with 6 decimal places (e.g. "1677890123.456789").
 * Safe to use as the `oldest` or `latest` parameter in conversations.history API.
 *
 * For 'all' preset (Number.MAX_SAFE_INTEGER ms), returns '0' to fetch from the beginning.
 */
export function timestampToSlackTs(timestampMs: number): string {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return '0';
  return (timestampMs / 1000).toFixed(6);
}

/**
 * Resolve a SincePreset to a Slack timestamp string representing the
 * effective `oldest` boundary.
 *
 * @param preset - the lookback preset
 * @param now    - reference time (defaults to current time); injectable for testing
 */
export function resolveSincePreset(preset: SincePreset, now: Date = new Date()): string {
  if (preset === 'all') return '0';
  const cutoffMs = now.getTime() - sincePresetToMs(preset);
  return timestampToSlackTs(cutoffMs);
}

/**
 * Type-guard: checks whether a string is a valid SincePreset.
 */
export function isSincePreset(value: unknown): value is SincePreset {
  return typeof value === 'string' && (SINCE_PRESETS as readonly string[]).includes(value);
}

// ── Compact (unified) preset labels ────────────────────────────────────────────
// Used in UI dropdowns for both cadence and since selectors.
export const COMPACT_PRESET_LABELS: Record<SincePreset, string> = {
  '1m':  '1M',
  '5m':  '5M',
  '15m': '15M',
  '30m': '30M',
  '1h':  '1H',
  '2h':  '2H',
  '4h':  '4H',
  '6h':  '6H',
  '12h': '12H',
  '1d':  '1D',
  '3d':  '3D',
  '1w':  '1W',
  '2w':  '2W',
  '1mo': '1MO',
  '2mo': '2MO',
  '3mo': '3MO',
  '4mo': '4MO',
  '6mo': '6MO',
  '1y':  '1Y',
  '3y':  '3Y',
  '5y':  '5Y',
  '10y': '10Y',
  '20y': '20Y',
  'all': 'ALL',
};

// ── Boundary-aligned scheduling ─────────────────────────────────────────────

/**
 * Reference Monday: 1970-01-05 00:00:00 UTC = 345_600_000 ms since Unix epoch.
 */
const REF_MONDAY_MS = 4 * 24 * 60 * 60_000; // 345_600_000

/**
 * Compute the next boundary-aligned run time for a given cadence preset.
 * Always returns a time strictly after `now`.
 *
 * @param cadence - the scheduling cadence preset
 * @param now     - reference time (defaults to current time); injectable for testing
 */
export function computeNextBoundary(cadence: CadencePreset, now: Date = new Date()): Date {
  const ms = now.getTime();
  // +1 ms ensures we always advance past the current boundary
  const msP = ms + 1;

  switch (cadence) {
    case '1m': {
      const p = 60_000;
      return new Date(Math.ceil(msP / p) * p);
    }
    case '5m': {
      const p = 5 * 60_000;
      return new Date(Math.ceil(msP / p) * p);
    }
    case '15m': {
      const p = 15 * 60_000;
      return new Date(Math.ceil(msP / p) * p);
    }
    case '30m': {
      const p = 30 * 60_000;
      return new Date(Math.ceil(msP / p) * p);
    }
    case '1h': {
      const p = 60 * 60_000;
      return new Date(Math.ceil(msP / p) * p);
    }
    case '2h': {
      const p = 2 * 60 * 60_000;
      return new Date(Math.ceil(msP / p) * p);
    }
    case '4h': {
      const p = 4 * 60 * 60_000;
      return new Date(Math.ceil(msP / p) * p);
    }
    case '6h': {
      const p = 6 * 60 * 60_000;
      return new Date(Math.ceil(msP / p) * p);
    }
    case '12h': {
      const p = 12 * 60 * 60_000;
      return new Date(Math.ceil(msP / p) * p);
    }
    case '1d': {
      const p = 24 * 60 * 60_000;
      return new Date(Math.ceil(msP / p) * p);
    }
    case '3d': {
      const p = 3 * 24 * 60 * 60_000;
      return new Date(Math.ceil(msP / p) * p);
    }
    case '1w': {
      const weekMs = 7 * 24 * 60 * 60_000;
      const periods = Math.ceil((msP - REF_MONDAY_MS) / weekMs);
      return new Date(REF_MONDAY_MS + periods * weekMs);
    }
    case '2w': {
      const twoWeekMs = 14 * 24 * 60 * 60_000;
      const periods = Math.ceil((msP - REF_MONDAY_MS) / twoWeekMs);
      return new Date(REF_MONDAY_MS + periods * twoWeekMs);
    }
    case '1mo': {
      return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    }
    case '2mo': {
      const m = now.getUTCMonth();
      const next = Math.ceil((m + 1) / 2) * 2;
      if (next >= 12) return new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
      return new Date(Date.UTC(now.getUTCFullYear(), next, 1));
    }
    case '3mo': {
      const m = now.getUTCMonth();
      const next = Math.ceil((m + 1) / 3) * 3;
      if (next >= 12) return new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
      return new Date(Date.UTC(now.getUTCFullYear(), next, 1));
    }
    case '4mo': {
      const m = now.getUTCMonth();
      const next = Math.ceil((m + 1) / 4) * 4;
      if (next >= 12) return new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
      return new Date(Date.UTC(now.getUTCFullYear(), next, 1));
    }
    case '6mo': {
      const m = now.getUTCMonth();
      if (m < 6) return new Date(Date.UTC(now.getUTCFullYear(), 6, 1));
      return new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
    }
    case '1y': {
      return new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
    }
    default: {
      const p = 60 * 60_000;
      return new Date(Math.ceil(msP / p) * p);
    }
  }
}
