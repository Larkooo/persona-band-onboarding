import type { LocalTurnResult } from "../../shared/types";

/**
 * Built-in voice call: the browser listens with a simple voice activity detector, sends each utterance to the
 * Worker (speech to text, the call brain, and a reply), and plays the reply as speech.
 */

export interface LocalVoiceCallbacks {
  onConnect(): void;
  onCaption(role: "user" | "agent", text: string): void;
  onSpeaking(who: "agent" | "user" | "none"): void;
  onEnd(reason: "agent" | "user" | "error", detail?: string): void;
}

type Phase = "starting" | "speaking" | "listening" | "capturing" | "thinking" | "ended";

const SILENCE_MS = 9000;
const END_SILENCE_FRAMES_MS = 850;
const MAX_UTTERANCE_MS = 25000;
const ECHO_TAIL_MS = 350;

function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  // Merge very short fragments so each request carries a natural phrase.
  const out: string[] = [];
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (out.length && (out[out.length - 1].length < 24 || p.length < 12)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}

function words(s: string) {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((w) => w.length > 2));
}

/** True when what we "heard" is mostly the assistant's own voice leaking back through the speakers. */
function isEcho(heard: string, spoken: string): boolean {
  const h = words(heard);
  if (h.size < 2) return false;
  const s = words(spoken);
  let hit = 0;
  for (const w of h) if (s.has(w)) hit++;
  return hit / h.size > 0.7;
}

function encodeWav(chunks: Float32Array[], inRate: number, outRate = 16000): Blob {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    merged.set(c, o);
    o += c.length;
  }
  const ratio = inRate / outRate;
  const len = Math.floor(total / ratio);
  const pcm = new Int16Array(len);
  for (let i = 0; i < len; i++) {
    // Box filter over the source window: cheap anti-aliasing for speech.
    const a = Math.floor(i * ratio);
    const b = Math.min(total, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += merged[j];
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(buf);
  const str = (off: number, s: string) => [...s].forEach((ch, i) => dv.setUint8(off + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, outRate, true);
  dv.setUint32(28, outRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

export class LocalVoiceCall {
  private phase: Phase = "starting";
  private ctx: AudioContext;
  private audio: HTMLAudioElement;
  private stream: MediaStream | null = null;
  private proc: ScriptProcessorNode | null = null;
  private outAnalyser: AnalyserNode;
  private outData: Uint8Array<ArrayBuffer>;
  private muted = false;
  private floor = 0.008;
  private above = 0;
  private below = 0;
  private preroll: Float32Array[] = [];
  private utter: Float32Array[] = [];
  private utterStart = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: { kind: "context" | "user"; text: string }[] = [];
  private lastSpoken = "";
  private listenFrom = 0;
  private blobUrls: string[] = [];
  userLevel = 0;

  /** A method rather than a field check, so TypeScript does not narrow `phase` across awaits. */
  private ended() {
    return this.phase === "ended";
  }

  /** Construct inside the Accept click so audio is unlocked by the user gesture (iOS Safari needs this). */
  private callId = "";
  private firstMessage = "";

  constructor(
    private base: string,
    private cb: LocalVoiceCallbacks,
  ) {
    this.ctx = new AudioContext();
    this.ctx.resume().catch(() => {});
    this.audio = new Audio();
    this.audio.preload = "auto";
    this.audio.setAttribute("playsinline", "");
    // A silent play inside the gesture unlocks this element for later playback.
    this.audio.src = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    this.audio.play().catch(() => {});
    this.outAnalyser = this.ctx.createAnalyser();
    this.outAnalyser.fftSize = 512;
    this.outData = new Uint8Array(this.outAnalyser.frequencyBinCount);
    try {
      const src = this.ctx.createMediaElementSource(this.audio);
      src.connect(this.outAnalyser);
      this.outAnalyser.connect(this.ctx.destination);
    } catch {
      // Level metering is optional; playback still works without the graph.
    }
  }

  /** Release audio without ever starting (the call went to ElevenLabs instead). */
  dispose() {
    if (this.phase !== "starting") return;
    this.phase = "ended";
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx.close().catch(() => {});
  }

  async start(callId: string, firstMessage: string, stream?: MediaStream) {
    this.callId = callId;
    this.firstMessage = firstMessage;
    try {
      this.stream =
        stream ?? (await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }));
    } catch {
      this.finish("error", "microphone blocked");
      return;
    }
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.proc = this.ctx.createScriptProcessor(2048, 1, 1);
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    src.connect(this.proc);
    this.proc.connect(sink).connect(this.ctx.destination);
    this.proc.onaudioprocess = (e) => this.onFrame(e.inputBuffer.getChannelData(0));
    this.cb.onConnect();
    this.cb.onCaption("agent", this.firstMessage);
    this.lastSpoken = this.firstMessage;
    // The first line is known already, so speak it without waiting on the brain. Register it server side too.
    void this.post("start");
    await this.speak(this.firstMessage);
    this.listen();
  }

  agentLevel(): number {
    if (this.phase !== "speaking") return 0;
    this.outAnalyser.getByteTimeDomainData(this.outData);
    let sum = 0;
    for (const v of this.outData) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.outData.length) * 4);
  }

  setMuted(m: boolean) {
    this.muted = m;
  }

  /** Something happened outside the call (Gmail connected, a typed message). */
  context(text: string) {
    this.enqueue({ kind: "context", text });
  }

  userText(text: string) {
    this.enqueue({ kind: "user", text });
  }

  hangUp() {
    this.finish("user");
  }

  // ---------- internals ----------

  private enqueue(item: { kind: "context" | "user"; text: string }) {
    if (this.phase === "listening") void this.turn(item.kind, undefined, item.text);
    else this.queue.push(item);
  }

  private onFrame(input: Float32Array) {
    if (this.phase === "ended") return;
    const frame = new Float32Array(input);
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = this.muted ? 0 : Math.sqrt(sum / frame.length);
    this.userLevel += (Math.min(1, rms * 8) - this.userLevel) * 0.4;
    const frameMs = (frame.length / this.ctx.sampleRate) * 1000;

    // The mic is ignored while the assistant speaks and briefly after: without WebRTC echo cancellation the
    // speakers bleed into the mic, and treating that as the user talking cut replies off after a word.
    if (this.phase === "listening" && performance.now() >= this.listenFrom) {
      const threshold = Math.max(0.018, this.floor * 3.2);
      if (rms > threshold) this.above++;
      else {
        this.above = 0;
        if (rms < this.floor * 2.5) this.floor = Math.max(0.002, this.floor * 0.95 + rms * 0.05);
      }
      this.preroll.push(frame);
      if (this.preroll.length > 6) this.preroll.shift();
      if (this.above >= 2) {
        this.phase = "capturing";
        clearTimeout(this.silenceTimer);
        this.utter = [...this.preroll];
        this.utterStart = performance.now();
        this.below = 0;
        this.cb.onSpeaking("user");
      }
      return;
    }

    if (this.phase === "capturing") {
      this.utter.push(frame);
      const threshold = Math.max(0.012, this.floor * 2.2);
      this.below = rms < threshold ? this.below + frameMs : 0;
      const long = performance.now() - this.utterStart > MAX_UTTERANCE_MS;
      if (this.below >= END_SILENCE_FRAMES_MS || long) {
        const chunks = this.utter;
        this.utter = [];
        this.cb.onSpeaking("none");
        const voicedMs = (chunks.length * frameMs) - this.below;
        if (voicedMs < 300) {
          this.listen(); // a click or a cough
          return;
        }
        void this.turn("user", encodeWav(chunks, this.ctx.sampleRate));
      }
    }
  }

  private listen() {
    if (this.phase === "ended") return;
    const next = this.queue.shift();
    if (next) {
      void this.turn(next.kind, undefined, next.text);
      return;
    }
    this.phase = "listening";
    this.listenFrom = performance.now() + ECHO_TAIL_MS;
    this.above = 0;
    this.preroll = [];
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.phase === "listening" && void this.turn("silence"), SILENCE_MS);
  }

  private post(kind: string, body?: Blob, text?: string): Promise<LocalTurnResult> {
    const q = new URLSearchParams({ callId: this.callId, kind });
    if (text) q.set("text", text);
    return fetch(`${this.base}/call/turn?${q}`, {
      method: "POST",
      headers: body ? { "content-type": "audio/wav" } : {},
      body,
    })
      .then((r) => r.json())
      .catch(() => ({ ok: false, error: "network" }));
  }

  private async turn(kind: "user" | "silence" | "context", audio?: Blob, text?: string) {
    if (this.phase === "ended") return;
    this.phase = "thinking";
    clearTimeout(this.silenceTimer);
    const r = await this.post(kind, audio, text);
    if (this.ended()) return;
    if (!r.ok) {
      if (r.error === "not_active") return this.finish("error", "call closed on server");
      // Nothing usable was heard. Keep listening rather than making the user repeat an error message.
      this.listen();
      return;
    }
    if (r.heard) {
      if (isEcho(r.heard, this.lastSpoken)) {
        this.listen();
        return;
      }
      this.cb.onCaption("user", r.heard);
    } else if (kind === "user" && text) this.cb.onCaption("user", text);
    if (r.say) {
      this.cb.onCaption("agent", r.say);
      this.lastSpoken = r.say;
      await this.speak(r.say);
    }
    if (this.ended()) return;
    if (r.end) return this.finish("agent");
    this.listen();
  }

  /** Fetch every sentence in parallel and play them in order, so later sentences are ready when needed. */
  private async speak(text: string) {
    if (this.phase === "ended") return;
    this.phase = "speaking";
    const url = (t: string) => `${this.base}/call/tts?${new URLSearchParams({ callId: this.callId, text: t })}`;
    const sentences = splitSentences(text);
    // Whole files rather than a live stream: Safari will not reliably play a chunked MP3 response.
    const clips = sentences.map((s) =>
      fetch(url(s))
        .then((r) => (r.ok ? r.blob() : null))
        .then((b) => {
          if (!b || !b.size) return null;
          const u = URL.createObjectURL(b);
          this.blobUrls.push(u);
          return u;
        })
        .catch(() => null),
    );
    for (const clip of clips) {
      const src = await clip;
      if (this.ended()) break;
      if (!src) continue;
      this.cb.onSpeaking("agent");
      await this.play(src);
    }
    this.cb.onSpeaking("none");
  }

  private play(src: string): Promise<void> {
    return new Promise((resolve) => {
      const a = this.audio;
      const done = () => {
        a.onended = a.onerror = a.onpause = null;
        resolve();
      };
      a.onended = done;
      a.onerror = done;
      a.onpause = () => {
        if (this.phase === "ended") done();
      };
      a.src = src;
      a.play().catch(done);
    });
  }

  private finish(reason: "agent" | "user" | "error", detail?: string) {
    if (this.phase === "ended") return;
    this.phase = "ended";
    clearTimeout(this.silenceTimer);
    try {
      this.audio.pause();
      this.audio.removeAttribute("src");
    } catch {}
    this.proc?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    for (const u of this.blobUrls) URL.revokeObjectURL(u);
    this.ctx.close().catch(() => {});
    this.cb.onSpeaking("none");
    this.cb.onEnd(reason, detail);
  }
}
