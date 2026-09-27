import { DurableObject } from "cloudflare:workers";
import type {
  CallJoin,
  CallOutcome,
  CallRecord,
  ChatMessage,
  ClientEvent,
  MessageKind,
  ServerEvent,
  SessionState,
} from "../shared/types";
import { DEFAULT_AGENT_NAME, missingFields } from "../shared/types";
import { extractFromTranscript, think, type BrainResult } from "./brain";
import { describeCall, stepQuestion } from "./prompts";
import { voiceThink } from "./localvoice";
import { callPrompt, elevenLabsConfigured, prepareCall, voiceConfigured } from "./voice";

const RING_TIMEOUT_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 35_000;
const MAX_CALLS = 6;
const MAX_MESSAGES = 400;
const DEBOUNCE_MS = 900;

const uid = () => crypto.randomUUID().slice(0, 12);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freshState(id: string, voiceAvailable: boolean): SessionState {
  return {
    id,
    channel: "web",
    createdAt: Date.now(),
    profile: { agentName: null, userName: null, phone: null, helpWith: null, gmail: { status: "none", address: null } },
    declined: { call: false, gmail: false },
    call: { phase: "idle", current: null, history: [] },
    started: false,
    graduated: false,
    graduatedEarly: false,
    voiceAvailable,
  };
}

function cleanName(raw: string): string | null {
  const t = raw
    .replace(/["“”'`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  if (!t || !/\p{L}/u.test(t)) return null;
  // Capitalize simple lowercase names, keep intentional casing like "JARVIS" or "McKenzie".
  return t === t.toLowerCase() ? t.replace(/(^|\s|-)\p{L}/gu, (c) => c.toUpperCase()) : t;
}

function cleanPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return raw.replace(/[^\d+()\-.\s]/g, "").trim();
}

const wordSet = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []);

/** Add a new help request unless it restates one we already have; keep the more specific wording. */
function mergeHelp(existing: string | null, next: string): string {
  if (!existing) return next;
  const parts = existing.split("; ");
  const n = wordSet(next);
  for (let i = 0; i < parts.length; i++) {
    const e = wordSet(parts[i]);
    const shared = [...n].filter((w) => e.has(w)).length;
    if (shared / Math.max(1, Math.min(n.size, e.size)) >= 0.6) {
      if (next.length > parts[i].length) parts[i] = next;
      return parts.join("; ").slice(0, 240);
    }
  }
  return [...parts, next].join("; ").slice(0, 240);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const NON_GOOGLE = /@(outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|zoho|gmx|yandex|mail)\./i;

export class OnboardingSession extends DurableObject<Env> {
  private state!: SessionState;
  private messages: ChatMessage[] = [];
  private gen = 0;
  private lastHeartbeat = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<SessionState>("state")) ?? (null as unknown as SessionState);
      this.messages = (await ctx.storage.get<ChatMessage[]>("messages")) ?? [];
    });
  }

  // ---------- persistence and push ----------

  private async save() {
    if (this.messages.length > MAX_MESSAGES) this.messages = this.messages.slice(-MAX_MESSAGES);
    await this.ctx.storage.put({ state: this.state, messages: this.messages });
  }

  private broadcast(ev: ServerEvent) {
    const data = JSON.stringify(ev);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {}
    }
  }

  private pushState() {
    this.broadcast({ type: "state", state: this.state });
  }

  private add(role: ChatMessage["role"], kind: MessageKind, text: string, meta?: Record<string, unknown>) {
    const m: ChatMessage = { id: uid(), role, kind, text, ts: Date.now(), meta };
    this.messages.push(m);
    if (kind !== "event") this.broadcast({ type: "message", message: m });
    return m;
  }

  private event(text: string) {
    return this.add("system", "event", text, { event: text });
  }

  // ---------- lifecycle ----------

  async init(id: string): Promise<{ state: SessionState; messages: ChatMessage[] }> {
    const voice = voiceConfigured(this.env);
    if (!this.state) {
      this.state = freshState(id, voice);
      await this.save();
    } else if (this.state.voiceAvailable !== voice || this.state.started === undefined) {
      this.state.voiceAvailable = voice;
      this.state.started ??= this.messages.length > 0;
      await this.save();
    }
    return this.snapshot();
  }

  /** The Start button: say hello and ring the band. Without voice, start by text instead. */
  async start(): Promise<{ ok: boolean }> {
    if (!this.state) return { ok: false };
    if (this.state.started) return { ok: true };
    this.state.started = true;
    if (this.state.voiceAvailable) {
      this.add("assistant", "text", "Hi, this is Persona, your new assistant. I'm calling your band now so we can get to know each other.");
      await this.save();
      this.pushState();
      await this.ring();
    } else {
      this.add("assistant", "text", "Hi, this is Persona, your new assistant. I'm here to take care of the small things that tend to pile up, like email and scheduling.");
      this.add("assistant", "text", "Before we get started, what would you like to call me?");
      await this.save();
      this.pushState();
    }
    return { ok: true };
  }

  private snapshot() {
    return { state: this.state, messages: this.messages.filter((m) => m.kind !== "event") };
  }

  async reset(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(4000, "reset");
    await this.ctx.storage.deleteAll();
    this.state = null as unknown as SessionState;
    this.messages = [];
    this.gen++;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    if (this.state) pair[1].send(JSON.stringify({ type: "snapshot", ...this.snapshot() } satisfies ServerEvent));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(_ws: WebSocket, raw: string | ArrayBuffer) {
    let ev: ClientEvent;
    try {
      ev = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (ev.type === "heartbeat" && this.state?.call.current?.id === ev.callId) {
      this.lastHeartbeat = Date.now();
      await this.ctx.storage.put("hb", this.lastHeartbeat);
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "bye");
    } catch {}
  }

  // ---------- text conversation ----------

  async userMessage(text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.state) return { ok: false, error: "no_session" };
    this.state.started = true;
    const clean = text.replace(/\s+$/g, "").slice(0, 1500);
    if (!clean.trim()) return { ok: false, error: "empty" };
    this.add("user", "text", clean);
    await this.save();

    // Mid-call texts go straight to the voice agent as the user's turn.
    if (this.state.call.phase === "active") {
      this.broadcast({ type: "call_user_text", text: clean });
      return { ok: true };
    }
    await this.respond(DEBOUNCE_MS, "user");
    return { ok: true };
  }

  /**
   * Run the brain over the whole thread and commit its reply. A newer message or event bumps `gen`,
   * which discards this run so rapid-fire texts get one combined answer.
   */
  private async respond(debounceMs = 0, trigger: "user" | "event" = "event") {
    const myGen = ++this.gen;
    this.broadcast({ type: "typing", on: true });
    if (debounceMs) await sleep(debounceMs);
    if (myGen !== this.gen) return;
    const phaseBefore = this.state.call.phase;
    const result = await think(this.env, this.state, this.messages);
    if (myGen !== this.gen || !this.state) return;
    // A call started while this reply was being written (the call button). Keep what it learned, drop what it says.
    if (phaseBefore === "idle" && this.state.call.phase !== "idle") {
      result.replies = [];
      result.action = "none";
    }
    // Only the user can start a call. Follow-ups to events (a missed or dropped call) may offer one, never place it.
    if (trigger !== "user" && result.action === "call") result.action = "none";
    await this.apply(result);
    this.broadcast({ type: "typing", on: false });
  }

  private async apply(r: BrainResult) {
    const s = this.state;
    const p = s.profile;
    const u = r.updates;
    if (u.agent_name) p.agentName = cleanName(u.agent_name) ?? p.agentName;
    if (u.user_name) p.userName = cleanName(u.user_name) ?? p.userName;
    if (u.phone) p.phone = cleanPhone(u.phone) ?? p.phone;
    if (u.help_with) p.helpWith = u.help_with;
    if (u.email && EMAIL_RE.test(u.email) && p.gmail.status !== "connected") p.gmail.address = u.email.toLowerCase();
    if (r.declined.call) s.declined.call = true;
    if (r.declined.gmail && p.gmail.status !== "connected") s.declined.gmail = true;

    // Before onboarding is done, never let a reply trail off without steering back to the open step.
    const replies = [...r.replies];
    if (r.action === "none" && !s.graduated && s.call.phase === "idle" && !replies.some((t) => t.includes("?"))) {
      const step = stepQuestion(s, "text");
      if (step && !replies.some((t) => step.covered.test(t))) replies.push(step.q);
    }
    for (const text of replies) this.add("assistant", "text", text);

    let ring = false;
    if (r.action === "gmail_link" && p.gmail.status !== "connected") {
      p.gmail.status = "link_sent";
      s.declined.gmail = false;
      this.add("assistant", "gmail_card", "Connect Gmail");
    } else if (r.action === "call") {
      if (!s.voiceAvailable) this.event("You tried to call, but calling is not available right now. Continue by text.");
      else if (s.call.phase !== "idle") {
        // Already ringing or on a call. Nothing to do.
      } else if (s.call.history.length >= MAX_CALLS) {
        this.event("You tried to call again, but the call limit for this conversation was reached. Continue by text.");
      } else {
        s.declined.call = false;
        ring = true;
      }
    } else if (r.action === "finish_onboarding" && !s.graduated) {
      this.graduate();
    }
    if (!s.graduated && !missingFields(s).length && s.call.phase === "idle") this.graduate();

    await this.save();
    this.pushState();
    if (ring) await this.ring();
    // "Can't talk now" typed while it rings: stop ringing. The reply above already covers it.
    else if ((r.action === "stop_call" || r.declined.call) && s.call.phase === "ringing" && s.call.current) {
      await this.finishCall(s.call.current.id, "declined", [], undefined, false);
    }
  }

  private graduate() {
    const s = this.state;
    s.graduated = true;
    s.graduatedEarly = missingFields(s).length > 0;
    if (!s.profile.agentName) s.profile.agentName = DEFAULT_AGENT_NAME;
    this.add("system", "divider", "Onboarding complete");
  }

  // ---------- calls ----------

  private async ring(callback = false) {
    const rec: CallRecord = { id: uid(), startedAt: Date.now(), transcript: [], callback };
    this.state.call.phase = "ringing";
    this.state.call.current = rec;
    await this.save();
    this.pushState();
    this.broadcast({ type: "ring", callId: rec.id });
    await this.ctx.storage.setAlarm(Date.now() + RING_TIMEOUT_MS);
  }

  /** User asked for a call from the UI (e.g. the "Call back" button). */
  async requestCall(): Promise<{ ok: boolean; error?: string }> {
    if (!this.state) return { ok: false, error: "no_session" };
    if (!this.state.voiceAvailable) return { ok: false, error: "voice_unavailable" };
    if (this.state.call.phase !== "idle") return { ok: true };
    if (this.state.call.history.length >= MAX_CALLS) return { ok: false, error: "call_limit" };
    this.state.declined.call = false;
    this.broadcast({ type: "typing", on: false });
    await this.ring();
    return { ok: true };
  }

  async answer(callId: string, transport: "webrtc" | "websocket" | "local" = "webrtc"): Promise<{ ok: true; join: CallJoin } | { ok: false; error: string }> {
    const c = this.state?.call.current;
    if (!c || c.id !== callId) return { ok: false, error: "not_ringing" };
    // Re-joining a live call (e.g. retrying over WebSocket after WebRTC failed) just issues fresh credentials.
    if (this.state.call.phase === "active") return { ok: true, join: await this.join(c.id, transport) };
    if (this.state.call.phase !== "ringing") return { ok: false, error: "not_ringing" };
    const join = await this.join(c.id, transport);
    // The call may have been declined or timed out while we fetched the token.
    if (this.state.call.current?.id !== callId) return { ok: false, error: "not_ringing" };
    c.answeredAt = Date.now();
    this.state.call.phase = "active";
    this.lastHeartbeat = Date.now();
    await this.save();
    this.pushState();
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_TIMEOUT_MS);
    return { ok: true, join };
  }

  /** ElevenLabs when it is configured and healthy, otherwise the built-in voice. Either way the call connects. */
  private async join(callId: string, transport: "webrtc" | "websocket" | "local"): Promise<CallJoin> {
    if (elevenLabsConfigured(this.env) && transport !== "local") {
      try {
        return await prepareCall(this.env, this.state, this.messages, callId, transport);
      } catch (e) {
        console.error("elevenlabs unavailable, using built-in voice", String(e));
      }
    }
    const { firstMessage } = callPrompt(this.state, this.messages);
    return { callId, mode: "local", prompt: "", firstMessage, dynamicVariables: {} };
  }

  async callActive(callId: string): Promise<boolean> {
    return !!callId && this.state?.call.phase === "active" && this.state.call.current?.id === callId;
  }

  /** One turn of a call on the built-in voice path. */
  async localTurn(
    callId: string,
    kind: "start" | "user" | "silence" | "context",
    text: string,
  ): Promise<{ ok: boolean; say?: string; end?: boolean; error?: string }> {
    const c = this.state?.call.current;
    if (!c || c.id !== callId || this.state.call.phase !== "active") return { ok: false, error: "not_active" };
    this.lastHeartbeat = Date.now();
    if (kind === "start") {
      if (c.transcript.length) return { ok: true, say: c.transcript[c.transcript.length - 1].text };
      const { firstMessage } = callPrompt(this.state, this.messages);
      c.transcript.push({ role: "agent", text: firstMessage });
      await this.save();
      return { ok: true, say: firstMessage };
    }
    if (kind === "silence") {
      // Deterministic: one check-in, then a polite exit. Models tend to talk past "[silence]" notes.
      const last = c.transcript[c.transcript.length - 1];
      const again = last?.role === "agent" && last.text.startsWith("Are you still there");
      const say = again
        ? "It sounds like now might not be a good time. I will follow up with you by text. Talk soon."
        : `Are you still there${this.state.profile.userName ? `, ${this.state.profile.userName}` : ""}? Take your time.`;
      c.transcript.push({ role: "agent", text: say });
      await this.save();
      return { ok: true, say, end: again };
    }
    if (kind === "user") c.transcript.push({ role: "user", text });
    else c.transcript.push({ role: "user", text: `[note: ${text}]` });

    const t = await voiceThink(this.env, this.state, this.messages, c.transcript);
    const cur = this.state?.call.current;
    if (!cur || cur.id !== callId) return { ok: false, error: "not_active" }; // hung up while thinking
    if (t.user_name) await this.tool("save_user_name", { name: t.user_name });
    if (t.help_with) await this.tool("save_help_request", { summary: t.help_with });
    if (t.decline_gmail) await this.tool("decline_gmail", {});
    if (t.send_gmail_link && this.state.profile.gmail.status !== "connected") await this.tool("send_gmail_link", {});
    let say = t.say;
    if (!t.end_call && !say.includes("?")) {
      const step = stepQuestion(this.state, "voice");
      if (step && !step.covered.test(say)) say = `${say} ${step.q}`;
    }
    cur.transcript.push({ role: "agent", text: say });
    await this.save();
    return { ok: true, say, end: t.end_call };
  }

  async decline(callId: string) {
    if (this.state?.call.current?.id === callId && this.state.call.phase === "ringing") {
      await this.finishCall(callId, "declined", []);
    }
    return { ok: true };
  }

  /** The browser reports how the call ended, with whatever transcript it captured. */
  async endCall(callId: string, reason: "agent" | "user" | "error" | "failed", transcript: CallRecord["transcript"], detail?: string) {
    const c = this.state?.call.current;
    if (!c || c.id !== callId) return { ok: true };
    let outcome: CallOutcome;
    if (reason === "failed") outcome = "failed";
    else if (this.state.call.phase === "ringing") outcome = reason === "error" ? "failed" : "declined";
    else if (reason === "agent") outcome = "completed";
    else if (reason === "user") outcome = "hung_up";
    else outcome = "dropped";
    await this.finishCall(callId, outcome, transcript, detail);
    return { ok: true };
  }

  async alarm() {
    const c = this.state?.call.current;
    if (!c) return;
    if (this.state.call.phase === "ringing") {
      if (Date.now() - c.startedAt >= RING_TIMEOUT_MS - 500) await this.finishCall(c.id, "missed", []);
      else await this.ctx.storage.setAlarm(c.startedAt + RING_TIMEOUT_MS);
    } else if (this.state.call.phase === "active") {
      // Memory is wiped if the object hibernated mid-call, so fall back to the stored heartbeat.
      const hb = Math.max(this.lastHeartbeat, (await this.ctx.storage.get<number>("hb")) ?? 0, c.answeredAt ?? 0);
      if (Date.now() - hb > HEARTBEAT_TIMEOUT_MS) {
        this.broadcast({ type: "call_end", callId: c.id });
        await this.finishCall(c.id, "dropped", c.transcript, "no heartbeat");
      } else await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_TIMEOUT_MS);
    }
  }

  private async finishCall(
    callId: string,
    outcome: CallOutcome,
    transcript: CallRecord["transcript"],
    detail?: string,
    followUp = true,
  ) {
    const s = this.state;
    const c = s.call.current;
    if (!c || c.id !== callId) return;
    c.endedAt = Date.now();
    c.outcome = outcome;
    c.detail = detail;
    if (transcript.length > c.transcript.length)
      c.transcript = transcript.slice(-80).map((t) => ({ role: t.role, text: String(t.text).slice(0, 1000) }));
    s.call.history.push(c);
    s.call.current = null;
    s.call.phase = "idle";

    const dur = c.answeredAt ? Math.max(1, Math.round((c.endedAt - c.answeredAt) / 1000)) : 0;
    const label: Record<CallOutcome, string> = {
      completed: "Call",
      hung_up: "Call",
      dropped: "Call dropped",
      declined: "Declined call",
      missed: "Missed call",
      failed: "Call failed",
      unavailable: "Call failed",
    };
    this.add("system", "call_log", label[outcome], { outcome, seconds: dur });

    if (outcome === "declined" && !c.answeredAt) s.declined.call = true;
    await this.save();
    this.pushState();

    // Safety net: pull anything the voice agent heard but did not save.
    let wantsToStop = false;
    if (c.transcript.some((t) => t.role === "user")) {
      const x = await extractFromTranscript(this.env, c.transcript);
      wantsToStop = !!x?.wants_to_stop;
      if (x && this.state) {
        const p = this.state.profile;
        if (!p.userName && x.user_name) p.userName = cleanName(x.user_name);
        if (!p.helpWith && x.help_with) p.helpWith = x.help_with;
        if (x.email && EMAIL_RE.test(x.email) && !p.gmail.address) p.gmail.address = x.email.toLowerCase();
        if (x.declined_gmail && p.gmail.status !== "connected") this.state.declined.gmail = true;
        if (x.summary) this.event(`Summary of the call: ${x.summary}`);
      }
    }
    if (!this.state) return;
    const p = this.state.profile;
    const facts = [
      `their name is ${p.userName ?? "still unknown"}`,
      `they want help with ${p.helpWith ?? "something not yet known"}`,
      p.gmail.status === "connected" ? `Gmail is connected (${p.gmail.address})` : this.state.declined.gmail ? "they chose not to connect Gmail" : "Gmail is not connected",
    ].join("; ");
    const guidance =
      outcome === "completed"
        ? "Send a short follow-up: thank them for the call in a few words and confirm the first concrete thing you will do for them. Only ask a question if something is still missing."
        : "Follow up by text and continue from where things stand.";
    this.event(`That was ${describeCall(c)}. Right now: ${facts}. ${guidance}`);
    await this.save();
    if (followUp && this.shouldCallBack(c, outcome, wantsToStop)) {
      this.add(
        "assistant",
        "text",
        outcome === "dropped"
          ? "Sorry, it looks like we got cut off. I'm calling you back now."
          : "It looks like the call ended before we finished. I'm calling you back now, and if now isn't a good time you can decline and we'll continue here.",
      );
      await this.save();
      await sleep(2500); // let the hang-up settle on screen before it rings again
      if (this.state?.call.phase === "idle" && !this.state.graduated) await this.ring(true);
      return;
    }
    if (followUp) await this.respond();
  }

  /**
   * A call that dropped or ended early gets one call back (two for connection drops), unless the user said they
   * had to go, onboarding is already done, or nothing is left that a call would cover.
   */
  private shouldCallBack(c: CallRecord, outcome: CallOutcome, wantsToStop: boolean): boolean {
    const s = this.state;
    if (!s || s.graduated || wantsToStop || s.declined.call || !s.voiceAvailable) return false;
    if (outcome !== "dropped" && outcome !== "hung_up") return false;
    if (c.detail === "time limit reached") return false;
    if (!missingFields(s).some((f) => f !== "agentName")) return false;
    const callbacks = s.call.history.filter((h) => h.callback).length;
    const limit = outcome === "dropped" ? 2 : 1;
    return callbacks < limit && s.call.history.length < MAX_CALLS;
  }

  // ---------- tools the voice agent calls (relayed by the browser) ----------

  async tool(name: string, args: Record<string, unknown>): Promise<string> {
    const s = this.state;
    if (!s) return "Error: no session.";
    const p = s.profile;
    let out: string;
    switch (name) {
      case "save_user_name": {
        const n = cleanName(String(args.name ?? ""));
        if (!n) return "That did not look like a name. Ask again.";
        p.userName = n;
        out = `Saved. Their name is ${n}.`;
        break;
      }
      case "save_help_request": {
        const h = String(args.summary ?? "").trim().slice(0, 240);
        if (!h) return "Nothing to save.";
        p.helpWith = mergeHelp(p.helpWith, h);
        out = "Saved.";
        break;
      }
      case "send_gmail_link": {
        if (p.gmail.status === "connected") return `Gmail is already connected (${p.gmail.address}).`;
        p.gmail.status = "link_sent";
        s.declined.gmail = false;
        this.add("assistant", "gmail_card", "Connect Gmail");
        out = "Sent. A 'Connect Gmail' link is now in their messages. Tell them they can open it while you stay on the line, and that you will know when it is done.";
        break;
      }
      case "check_gmail_status":
        return p.gmail.status === "connected"
          ? `Connected as ${p.gmail.address}.`
          : p.gmail.status === "link_sent"
            ? "Not connected yet. The link has been sent."
            : "Not connected, and no link has been sent yet.";
      case "decline_gmail":
        if (p.gmail.status !== "connected") s.declined.gmail = true;
        out = "Noted. Do not bring Gmail up again on this call.";
        break;
      default:
        return `Unknown tool ${name}.`;
    }
    await this.save();
    this.pushState();
    return out;
  }

  // ---------- Gmail connect sheet ----------

  async gmailConnect(email: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.state;
    if (!s) return { ok: false, error: "no_session" };
    const e = email.trim().toLowerCase();
    if (!EMAIL_RE.test(e)) return { ok: false, error: "Enter a valid email address." };
    if (NON_GOOGLE.test(e)) return { ok: false, error: "This address does not belong to a Google account. Use a Gmail or Google Workspace address." };
    s.profile.gmail = { status: "connected", address: e };
    s.declined.gmail = false;
    await this.save();
    this.pushState();
    const note = `The user just connected their Gmail account (${e}).`;
    if (s.call.phase === "active") {
      this.broadcast({ type: "call_context", text: `${note} Acknowledge it briefly and continue.` });
      this.event(note);
      await this.save();
    } else {
      this.event(note);
      await this.save();
      await this.respond();
    }
    return { ok: true };
  }

  async gmailCancel(): Promise<{ ok: boolean }> {
    const s = this.state;
    if (!s || s.profile.gmail.status === "connected") return { ok: true };
    const note = "The user opened the Gmail link but closed it without connecting.";
    if (s.call.phase === "active") {
      this.broadcast({ type: "call_context", text: `${note} Ask if they ran into anything, once, without pushing.` });
      this.event(note);
      await this.save();
    }
    // Outside a call, stay quiet: closing a sheet is not worth a message.
    return { ok: true };
  }
}
