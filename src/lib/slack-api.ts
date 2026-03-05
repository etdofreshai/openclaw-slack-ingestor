/**
 * Slack Web API helpers for token validation and message sync.
 *
 * Auth flow: Slack's API requires BOTH:
 *   1. The `d` cookie (browser session auth)
 *   2. An `xoxc-*` client token sent as a POST form parameter
 *
 * All requests use POST with application/x-www-form-urlencoded.
 * The xoxc token is captured during login and persisted with the session.
 */
import { getCookieString, hasSession, setSessionInfo, getApiToken } from "./session.js";

const SLACK_API_BASE = "https://slack.com/api";

interface ApiResponse<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

interface AuthTestResponse {
  url: string;
  team: string;
  team_id: string;
  user: string;
  user_id: string;
}

interface ConversationsListResponse {
  channels: Array<{
    id: string;
    name: string;
    is_channel: boolean;
    is_private: boolean;
    is_member: boolean;
  }>;
  response_metadata?: { next_cursor?: string };
}

interface ConversationHistoryResponse {
  ok: boolean;
  messages: Array<{
    ts: string;
    user?: string;
    bot_id?: string;
    username?: string;
    text?: string;
    thread_ts?: string;
    subtype?: string;
    files?: unknown[];
    attachments?: unknown[];
    reactions?: Array<{ name: string; count: number }>;
  }>;
  has_more: boolean;
  response_metadata?: { next_cursor?: string };
}

interface UserInfoResponse {
  user: {
    id: string;
    name: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
    };
  };
}

/**
 * POST-based Slack API wrapper.
 *
 * Slack's Web API requires:
 *  - Cookie header with the `d` session cookie
 *  - `token` POST field with the xoxc-* client token
 *  - Content-Type: application/x-www-form-urlencoded
 */
async function slackFetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<ApiResponse<T>> {
  if (!hasSession()) {
    const apiToken = getApiToken();
    if (!apiToken) {
      return { ok: false, error: "No xoxc-* API token — please re-login to capture token" };
    }
    return { ok: false, error: "No active Slack session (d cookie missing)" };
  }

  const apiToken = getApiToken()!;
  const url = `${SLACK_API_BASE}/${endpoint}`;

  // Debug: log token prefix for troubleshooting auth issues
  console.log(`[slack-api] ${endpoint} — token: ${apiToken.slice(0, 10)}…, d cookie: ${getCookieString().includes('d=') ? 'present' : 'MISSING'}`);

  // Build POST body: token first, then any additional params
  const formParams = new URLSearchParams({ token: apiToken, ...params });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Cookie": getCookieString(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: formParams.toString(),
    });

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }

    const data = await res.json() as Record<string, unknown>;
    if (!data.ok) {
      return { ok: false, error: (data.error as string) || "Unknown API error" };
    }

    return { ok: true, data: data as T };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Validate session by calling auth.test API.
 */
export async function validateSession(): Promise<{ valid: boolean; team?: string; user?: string; error?: string }> {
  // Try auth.test endpoint
  const result = await slackFetch<AuthTestResponse>("auth.test");
  
  if (!result.ok) {
    return { valid: false, error: result.error };
  }

  const { team, team_id, user, user_id } = result.data!;
  setSessionInfo({
    teamId: team_id,
    teamName: team,
    userId: user_id,
    userName: user,
  });

  return { valid: true, team, user };
}

/**
 * List available conversations/channels.
 */
export async function listChannels(): Promise<{ channels: Array<{ id: string; name: string }>; error?: string }> {
  const channels: Array<{ id: string; name: string }> = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = {
      types: "public_channel,private_channel,mpim,im",
      limit: "200",
    };
    if (cursor) params.cursor = cursor;

    const result = await slackFetch<ConversationsListResponse>("conversations.list", params);
    
    if (!result.ok) {
      return { channels, error: result.error };
    }

    for (const ch of result.data?.channels || []) {
      channels.push({ id: ch.id, name: ch.name });
    }

    cursor = result.data?.response_metadata?.next_cursor;
  } while (cursor);

  return { channels };
}

// Cache for user lookups
const userCache = new Map<string, string>();

/**
 * Get username for a user ID.
 */
export async function getUsername(userId: string): Promise<string> {
  if (userCache.has(userId)) return userCache.get(userId)!;

  const result = await slackFetch<UserInfoResponse>("users.info", { user: userId });
  
  if (!result.ok || !result.data?.user) {
    return userId;
  }

  const user = result.data.user;
  const name = user.profile?.display_name || user.profile?.real_name || user.real_name || user.name || userId;
  userCache.set(userId, name);
  return name;
}

/**
 * Fetch messages from a channel.
 */
export async function fetchChannelHistory(
  channelId: string,
  options: { oldest?: string; limit?: number } = {}
): Promise<{ messages: ConversationHistoryResponse["messages"]; hasMore: boolean; error?: string }> {
  const params: Record<string, string> = {
    channel: channelId,
    limit: String(options.limit || 200),
  };
  if (options.oldest) params.oldest = options.oldest;

  const result = await slackFetch<ConversationHistoryResponse>("conversations.history", params);

  if (!result.ok) {
    return { messages: [], hasMore: false, error: result.error };
  }

  return {
    messages: result.data?.messages || [],
    hasMore: result.data?.has_more || false,
  };
}

/**
 * Fetch all messages from a channel with pagination.
 */
export async function* fetchAllChannelMessages(
  channelId: string,
  options: { oldest?: string } = {}
): AsyncGenerator<ConversationHistoryResponse["messages"][0], void, unknown> {
  let cursor: string | undefined;
  let oldest = options.oldest;

  do {
    const params: Record<string, string> = {
      channel: channelId,
      limit: "200",
    };
    if (oldest) params.oldest = oldest;
    if (cursor) params.cursor = cursor;

    const result = await slackFetch<ConversationHistoryResponse>("conversations.history", params);

    if (!result.ok) {
      console.error(`[slack-api] Error fetching messages: ${result.error}`);
      return;
    }

    const messages = result.data?.messages || [];
    for (const msg of messages) {
      yield msg;
    }

    // Use oldest timestamp for incremental sync
    if (messages.length > 0 && !oldest) {
      oldest = messages[messages.length - 1].ts;
    }

    cursor = result.data?.response_metadata?.next_cursor;
  } while (cursor);
}

/**
 * Get channel info.
 */
export async function getChannelInfo(channelId: string): Promise<{ name?: string; error?: string }> {
  const result = await slackFetch<{ channel: { name: string } }>("conversations.info", { channel: channelId });
  
  if (!result.ok) {
    return { error: result.error };
  }

  return { name: result.data?.channel?.name };
}
