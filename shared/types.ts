// State shared by the Worker, the Durable Object and the web client.

export type Channel = "web" | "telegram";

export type GmailStatus = "none" | "link_sent" | "connected" | "declined";

export type CallOutcome =
  | "completed" // agent wrapped up and ended the call
  | "hung_up" // user ended the call before the agent finished
  | "declined" // user tapped decline while it was ringing
  | "missed" // nobody answered
  | "dropped" // connection lost, page closed, or an error mid-call
  | "failed" // the call could not start (no mic, voice service down, quota)
  | "unavailable"; // voice calls are not configured on this deployment

export interface CallRecord {
  id: string;
  startedAt: number;
  answeredAt?: number;
  endedAt?: number;
  outcome?: CallOutcome;
  detail?: string;
  /** We placed this call because the previous one dropped. */
  callback?: boolean;
  transcript: { role: "user" | "agent"; text: string }[];
}

export interface Profile {
  agentName: string | null;
  userName: string | null;
  phone: string | null;
  helpWith: string | null;
  gmail: { status: GmailStatus; address: string | null };
}

export type CallPhase = "idle" | "ringing" | "active";

export interface SessionState {
  id: string;
  channel: Channel;
  createdAt: number;
  profile: Profile;
  /** Things the user has said no to, so we stop asking. */
  declined: { call: boolean; gmail: boolean };
  call: { phase: CallPhase; current: CallRecord | null; history: CallRecord[] };
  /** The user pressed Start. Before that the page shows the start screen. */
  started: boolean;
  /** Onboarding is over and the assistant is in normal mode. */
  graduated: boolean;
  graduatedEarly: boolean;
  voiceAvailable: boolean;
}

export type MessageKind =
  | "text"
  | "gmail_card" // tappable "Connect Gmail" link
  | "call_log" // "Missed call", "Call, 2:14"
  | "divider" // centered system note, e.g. "Onboarding complete"
  | "event"; // hidden note for the model about something that happened

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  kind: MessageKind;
  text: string;
  ts: number;
  meta?: Record<string, unknown>;
}

// Server -> client push over the session WebSocket.
export type ServerEvent =
  | { type: "snapshot"; state: SessionState; messages: ChatMessage[] }
  | { type: "state"; state: SessionState }
  | { type: "message"; message: ChatMessage }
  | { type: "typing"; on: boolean }
  | { type: "ring"; callId: string }
  | { type: "call_context"; text: string } // tell the live voice agent about something that happened
  | { type: "call_user_text"; text: string } // a text the user typed mid-call, forwarded as their turn
  | { type: "call_end"; callId: string }; // end the live call from the server side

/** Response to one spoken turn on the built-in voice path. */
export interface LocalTurnResult {
  ok: boolean;
  heard?: string;
  say?: string;
  end?: boolean;
  error?: string;
}

// Client -> server over the session WebSocket.
export type ClientEvent = { type: "heartbeat"; callId: string } | { type: "ping" };

/** Everything the browser needs to join the voice call. */
export interface CallJoin {
  callId: string;
  /** "elevenlabs": join with the SDK. "local": the browser records turns and the Worker answers with speech. */
  mode: "elevenlabs" | "local";
  conversationToken?: string;
  signedUrl?: string;
  prompt: string;
  firstMessage: string;
  dynamicVariables: Record<string, string>;
}

/** What the assistant calls itself until the user picks a name. */
export const DEFAULT_AGENT_NAME = "Persona";

export const MISSING_ORDER = ["agentName", "userName", "helpWith", "gmail"] as const;
export type Field = (typeof MISSING_ORDER)[number];

export function missingFields(s: SessionState): Field[] {
  const p = s.profile;
  const out: Field[] = [];
  if (!p.agentName) out.push("agentName");
  if (!p.userName) out.push("userName");
  if (!p.helpWith) out.push("helpWith");
  if (p.gmail.status !== "connected" && !s.declined.gmail) out.push("gmail");
  return out;
}
