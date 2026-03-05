/**
 * Slack session persistence — cookies and auth tokens.
 */
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";

const DATA_ROOT = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : (process.env.NODE_ENV === 'production'
      ? '/app/.data'
      : path.resolve(process.cwd(), '.data'));
const SESSION_DIR = path.join(DATA_ROOT, 'session');
const SESSION_FILE_PATH = path.join(SESSION_DIR, "slack-session.json");
// Keep old path for backward compatibility migration
const LEGACY_SESSION_FILE = path.join(process.cwd(), ".chrome-profile", "slack-session.json");

// In-memory session store
interface SlackSession {
  cookies: Record<string, string>;
  localStorage?: Record<string, string>;
  teamId?: string;
  teamName?: string;
  userId?: string;
  userName?: string;
  lastValidated?: string;
  /** xoxc-* client token required for Slack Web API calls */
  apiToken?: string;
}

const session: SlackSession = {
  cookies: {},
};

// Slack auth cookies to capture
const AUTH_COOKIE_PATTERNS = [
  /^d$/,           // Main auth cookie
  /^d-s$/,         // Session cookie
  /^bip$/,         // User ID
  /^c$/,           // Team/workspace
  /^x$/,           // Additional auth
];

export function setCookies(cookies: Record<string, string>) {
  Object.assign(session.cookies, cookies);
}

export function getCookies(): Record<string, string> {
  return { ...session.cookies };
}

export function getCookieString(): string {
  return Object.entries(session.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/**
 * Full auth requires BOTH the `d` cookie AND an xoxc-* API token.
 * Without both, Slack API calls will return not_authed.
 */
export function hasSession(): boolean {
  return Boolean(session.cookies["d"] && session.apiToken);
}

/**
 * True when only the `d` cookie is present (partial auth — token still needed).
 */
export function hasDCookie(): boolean {
  return Boolean(session.cookies["d"]);
}

/** Get the captured xoxc-* API token. */
export function getApiToken(): string | undefined {
  return session.apiToken;
}

/** Store the captured xoxc-* API token. */
export function setApiToken(token: string): void {
  session.apiToken = token;
  console.log("[session] xoxc-* API token stored");
}

/** True when an xoxc-* token has been captured. */
export function hasApiToken(): boolean {
  return Boolean(session.apiToken);
}

export function setSessionInfo(info: Partial<SlackSession>) {
  if (info.teamId) session.teamId = info.teamId;
  if (info.teamName) session.teamName = info.teamName;
  if (info.userId) session.userId = info.userId;
  if (info.userName) session.userName = info.userName;
  session.lastValidated = new Date().toISOString();
}

export function getSessionInfo(): SlackSession {
  return { ...session };
}

export function isAuthCookie(name: string): boolean {
  return AUTH_COOKIE_PATTERNS.some(p => p.test(name));
}

/**
 * Save session to persistent file.
 */
export async function saveSessionToFile(): Promise<void> {
  try {
    await mkdir(SESSION_DIR, { recursive: true });
    const data = JSON.stringify(session, null, 2);
    await writeFile(SESSION_FILE_PATH, data, "utf8");
    console.log("[session] Slack session persisted to", SESSION_FILE_PATH);
  } catch (err) {
    console.error("[session] Failed to save session:", err);
  }
}

/**
 * Load session from persistent file.
 */
export async function loadSessionFromFile(): Promise<boolean> {
  // Try new path first, then migrate from legacy path
  let filePath = SESSION_FILE_PATH;
  try {
    await readFile(SESSION_FILE_PATH, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        await readFile(LEGACY_SESSION_FILE, "utf8");
        filePath = LEGACY_SESSION_FILE;
        console.log("[session] Found legacy session file, migrating to new path...");
      } catch {
        // Neither exists
      }
    }
  }

  try {
    const data = await readFile(filePath, "utf8");
    const parsed = JSON.parse(data) as SlackSession;
    
    if (typeof parsed !== "object" || parsed === null) {
      console.warn("[session] Invalid session file format");
      return false;
    }
    
    if (parsed.cookies && typeof parsed.cookies === "object") {
      Object.assign(session.cookies, parsed.cookies);
    }
    if (parsed.teamId) session.teamId = parsed.teamId;
    if (parsed.teamName) session.teamName = parsed.teamName;
    if (parsed.userId) session.userId = parsed.userId;
    if (parsed.userName) session.userName = parsed.userName;
    if (parsed.lastValidated) session.lastValidated = parsed.lastValidated;
    if (parsed.apiToken) {
      session.apiToken = parsed.apiToken;
      console.log("[session] xoxc-* API token loaded from file");
    }
    
    const ok = hasSession();
    if (ok) {
      console.log("[session] Slack session loaded from", filePath);
      // Migrate to new path if loaded from legacy
      if (filePath === LEGACY_SESSION_FILE) {
        await saveSessionToFile().catch(() => {});
      }
    } else if (session.cookies["d"] && !session.apiToken) {
      console.warn("[session] Loaded d cookie but no xoxc-* token — re-login required to capture API token");
    }
    return ok;
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    console.error("[session] Failed to load session:", err);
    return false;
  }
}

/**
 * Clear the current session.
 */
export function clearSession(): void {
  session.cookies = {};
  session.apiToken = undefined;
  session.teamId = undefined;
  session.teamName = undefined;
  session.userId = undefined;
  session.userName = undefined;
  session.lastValidated = undefined;
}
