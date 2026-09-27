import type { DisconnectionDetails, VoiceConversation } from "@elevenlabs/client";
import type { CallJoin } from "../../shared/types";
import { LocalVoiceCall } from "./localVoice";
import type { Session } from "./session";

// The ElevenLabs SDK is large (WebRTC). Load it when a call starts ringing, not on page load.
let sdk: Promise<typeof import("@elevenlabs/client")> | null = null;
const loadSdk = () => (sdk ??= import("@elevenlabs/client"));

export type CallUiPhase = "idle" | "ringing" | "connecting" | "active" | "ended";

export interface CallView {
  phase: CallUiPhase;
  callId: string | null;
  startedAt: number | null;
  speaking: "agent" | "user" | "none";
  caption: { role: "agent" | "user"; text: string } | null;
  muted: boolean;
  error: string | null;
}

const IDLE: CallView = { phase: "idle", callId: null, startedAt: null, speaking: "none", caption: null, muted: false, error: null };
const ACTIVE_KEY = "onboarding-active-call";

type Transcript = { role: "user" | "agent"; text: string }[];

/** What the controller needs from a running call, whichever engine carries it. */
interface Engine {
  hangUp(): void;
  setMuted(m: boolean): void;
  context(text: string): void;
  userText(text: string): void;
  levels(): { agent: number; user: number };
}

/**
 * Runs one voice call at a time and reports back to the session. ElevenLabs is tried first (WebRTC, then
 * WebSocket); if it is not configured or cannot connect, the built-in Workers AI voice carries the call.
 * Every way a call can end (hang up, agent goodbye, network drop, tab close, mic denied) funnels into `finish`.
 */
export class CallController {
  view: CallView = IDLE;
  private engine: Engine | null = null;
  private transcript: Transcript = [];
  private finished = new Set<string>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private listeners = new Set<(v: CallView) => void>();
  levels = { agent: 0, user: 0 };

  constructor(private session: () => Session) {}

  /** Returns a cleanup function, so it can live in a React effect (StrictMode mounts twice). */
  attach() {
    window.addEventListener("pagehide", this.onPageHide);
    return () => window.removeEventListener("pagehide", this.onPageHide);
  }

  on(fn: (v: CallView) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private set(patch: Partial<CallView>) {
    this.view = { ...this.view, ...patch };
    for (const fn of this.listeners) fn(this.view);
  }

  /** Server says a call is ringing. */
  ring(callId: string) {
    if (this.view.callId === callId && this.view.phase !== "idle" && this.view.phase !== "ended") return;
    if (this.engine) return; // already on a call in this tab
    this.transcript = [];
    this.set({ ...IDLE, phase: "ringing", callId });
  }

  /** Server state moved on (declined elsewhere, missed, ended). */
  serverIdle() {
    if (this.view.phase === "ringing") this.set({ ...IDLE });
    else if ((this.view.phase === "active" || this.view.phase === "connecting") && this.view.callId) {
      this.finished.add(this.view.callId); // server already closed it; don't report again
      const e = this.engine;
      this.cleanup();
      e?.hangUp();
      this.set({ phase: "ended", speaking: "none" });
      setTimeout(() => this.view.phase === "ended" && this.set({ ...IDLE }), 1600);
    }
  }

  /** Must be called from the Accept click: the built-in voice unlocks audio inside the gesture. */
  async accept() {
    const callId = this.view.callId;
    if (!callId || this.view.phase !== "ringing") return;
    const local = new LocalVoiceCall(`/api/s/${this.session().id}`, this.localCallbacks(callId));
    this.set({ phase: "connecting", error: null });

    // Ask for the mic first so a denial can be explained instead of surfacing as a vague SDK error.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      local.dispose();
      this.set({ error: "Microphone access is blocked, so the call could not connect. You can allow it in your browser settings or continue by text." });
      await this.report(callId, "failed", "microphone blocked");
      setTimeout(() => this.set({ ...IDLE }), 4200);
      return;
    }

    let join: CallJoin;
    try {
      const r = await this.session().post<{ ok: boolean; join?: CallJoin; error?: string }>("call/answer", { callId });
      if (!r.ok || !r.join) throw new Error(r.error ?? "answer failed");
      join = r.join;
    } catch (e: any) {
      local.dispose();
      stream.getTracks().forEach((t) => t.stop());
      const msg = e?.status === 429 ? "Too many calls in a short time. Please wait a minute." : "The call could not connect.";
      this.set({ error: msg });
      setTimeout(() => this.set({ ...IDLE }), 3000);
      return;
    }
    try {
      sessionStorage.setItem(ACTIVE_KEY, callId);
    } catch {}

    if (join.mode === "elevenlabs") {
      stream.getTracks().forEach((t) => t.stop()); // the SDK opens its own
      if (await this.startElevenLabs(callId, join)) return local.dispose();
      // WebRTC and WebSocket both failed: carry on with the built-in voice.
      const r = await this.session()
        .post<{ ok: boolean; join?: CallJoin }>("call/answer", { callId, transport: "local" })
        .catch(() => null);
      if (!r?.ok || !r.join) {
        local.dispose();
        this.set({ error: "The call dropped while connecting." });
        return this.finish(callId, "error", "could not connect to voice service");
      }
      join = r.join;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    }
    this.engine = {
      hangUp: () => local.hangUp(),
      setMuted: (m) => local.setMuted(m),
      context: (t) => local.context(t),
      userText: (t) => local.userText(t),
      levels: () => ({ agent: local.agentLevel(), user: local.userLevel }),
    };
    void local.start(callId, join.firstMessage, stream);
  }

  private localCallbacks(callId: string) {
    return {
      onConnect: () => this.connected(callId),
      onCaption: (role: "user" | "agent", text: string) => {
        this.transcript.push({ role, text });
        this.set({ caption: { role, text } });
      },
      onSpeaking: (who: "agent" | "user" | "none") => this.set({ speaking: who }),
      onEnd: (reason: "agent" | "user" | "error", detail?: string) => void this.finish(callId, reason, detail),
    };
  }

  private connected(callId: string) {
    this.set({ phase: "active", startedAt: Date.now() });
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.session().wsSend({ type: "heartbeat", callId }), 10000);
    this.session().wsSend({ type: "heartbeat", callId });
  }

  /** WebRTC first, then WebSocket. Returns false if neither connects. */
  private async startElevenLabs(callId: string, join: CallJoin): Promise<boolean> {
    const attempt = async (j: CallJoin) => {
      const { VoiceConversation } = await loadSdk();
      const creds = j.signedUrl
        ? ({ signedUrl: j.signedUrl, connectionType: "websocket" } as const)
        : ({ conversationToken: j.conversationToken!, connectionType: "webrtc" } as const);
      const conv: VoiceConversation = await VoiceConversation.startSession({
        ...creds,
        overrides: { agent: { prompt: { prompt: j.prompt }, firstMessage: j.firstMessage } },
        clientTools: this.tools(),
        onConnect: () => this.connected(callId),
        onMessage: ({ message, role }) => {
          const text = message?.trim();
          if (!text) return;
          this.transcript.push({ role, text });
          this.set({ caption: { role, text } });
        },
        onModeChange: ({ mode }) => this.set({ speaking: mode === "speaking" ? "agent" : "none" }),
        onDisconnect: (d) => this.onDisconnect(callId, d),
        onError: (message) => console.warn("call error", message),
      });
      this.engine = {
        hangUp: () => void conv.endSession().catch(() => {}),
        setMuted: (m) => conv.setMicMuted(m),
        context: (t) => conv.sendContextualUpdate(t),
        userText: (t) => conv.sendUserMessage(`(typed in messages) ${t}`),
        levels: () => {
          try {
            return { agent: conv.getOutputVolume(), user: this.view.muted ? 0 : conv.getInputVolume() };
          } catch {
            return { agent: 0, user: 0 };
          }
        },
      };
    };
    try {
      await attempt(join);
      return true;
    } catch (e) {
      console.warn("webrtc failed, retrying over websocket", e);
    }
    try {
      const r = await this.session().post<{ ok: boolean; join?: CallJoin }>("call/answer", { callId, transport: "websocket" });
      if (r.ok && r.join?.signedUrl) {
        await attempt(r.join);
        return true;
      }
    } catch (e) {
      console.warn("websocket failed", e);
    }
    return false;
  }

  async decline() {
    const callId = this.view.callId;
    if (!callId || this.view.phase !== "ringing") return;
    this.set({ ...IDLE });
    await this.session().post("call/decline", { callId }).catch(() => {});
  }

  async hangUp() {
    if (this.engine) this.engine.hangUp();
    else if (this.view.callId && this.view.phase !== "idle" && this.view.phase !== "ringing") await this.finish(this.view.callId, "user");
  }

  setMuted(m: boolean) {
    this.engine?.setMuted(m);
    this.set({ muted: m });
  }

  /** Something happened outside the call that the agent should know about. */
  context(text: string) {
    this.engine?.context(text);
  }

  userText(text: string) {
    this.engine?.userText(text);
  }

  /** Smoothed audio levels; call once per animation frame. */
  sample() {
    const e = this.engine;
    if (!e || this.view.phase !== "active") {
      this.levels.agent *= 0.85;
      this.levels.user *= 0.85;
      return this.levels;
    }
    const { agent, user } = e.levels();
    this.levels.agent += (agent - this.levels.agent) * 0.35;
    this.levels.user += ((this.view.muted ? 0 : user) - this.levels.user) * 0.35;
    return this.levels;
  }

  private tools() {
    const call = (name: string) => async (args: Record<string, unknown>) => {
      try {
        const r = await this.session().post<{ result: string }>("tool", { name, args });
        return r.result;
      } catch {
        return "That did not go through. Carry on without it.";
      }
    };
    return {
      save_user_name: call("save_user_name"),
      save_help_request: call("save_help_request"),
      send_gmail_link: call("send_gmail_link"),
      check_gmail_status: call("check_gmail_status"),
      decline_gmail: call("decline_gmail"),
    };
  }

  private onDisconnect(callId: string, d: DisconnectionDetails) {
    if (d.reason === "user") void this.finish(callId, "user");
    else if (d.reason === "agent") void this.finish(callId, "agent", d.context?.type);
    else void this.finish(callId, "error", d.context?.type === "max_duration_exceeded" ? "time limit reached" : d.message);
  }

  private async report(callId: string, reason: "agent" | "user" | "error" | "failed", detail?: string) {
    await this.session()
      .post("call/end", { callId, reason, detail, transcript: this.transcript })
      .catch(() => {});
  }

  private async finish(callId: string, reason: "agent" | "user" | "error", detail?: string) {
    if (this.finished.has(callId)) return;
    this.finished.add(callId);
    this.cleanup();
    this.set({ phase: "ended", speaking: "none" });
    await this.report(callId, reason, detail);
    setTimeout(() => this.view.phase === "ended" && this.set({ ...IDLE }), 1600);
  }

  private cleanup() {
    clearInterval(this.heartbeat);
    this.engine = null;
    try {
      sessionStorage.removeItem(ACTIVE_KEY);
    } catch {}
  }

  /** Closing or reloading the tab mid-call: tell the server with a beacon so the thread can pick up. */
  private onPageHide = () => {
    const callId = this.view.callId;
    if (!callId || (this.view.phase !== "active" && this.view.phase !== "connecting") || this.finished.has(callId)) return;
    this.finished.add(callId);
    const body = JSON.stringify({ callId, reason: "error", detail: "page closed", transcript: this.transcript });
    navigator.sendBeacon(`/api/s/${this.session().id}/call/end`, body);
  };

  /** After a reload, a call this tab owned is dead. Report it so the server does not wait for the heartbeat timeout. */
  static staleCallFromThisTab(activeCallId: string | undefined): boolean {
    try {
      return !!activeCallId && sessionStorage.getItem(ACTIVE_KEY) === activeCallId;
    } catch {
      return false;
    }
  }
}
