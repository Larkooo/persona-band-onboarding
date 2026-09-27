import { OnboardingSession } from "./session";
import { VoiceRegistry, elevenLabsConfigured, registry, voiceConfigured } from "./voice";
import { speakStream, transcribe } from "./localvoice";

export { OnboardingSession, VoiceRegistry };

const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function body<T>(req: Request): Promise<Partial<T>> {
  try {
    return (await req.json()) as Partial<T>;
  } catch {
    return {};
  }
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "s", id, action...]
    if (parts[0] !== "api") return new Response("Not found", { status: 404 });

    if (parts[1] === "health") {
      const el = elevenLabsConfigured(env);
      return json({ ok: true, voice: voiceConfigured(env), engine: el ? "elevenlabs" : "local", ...(el ? await registry(env).status() : {}) });
    }

    if (parts[1] !== "s" || !parts[2] || !SESSION_RE.test(parts[2])) return json({ error: "bad_request" }, 400);
    const id = parts[2];
    const action = parts.slice(3).join("/");
    const stub = env.SESSION.get(env.SESSION.idFromName(id));
    const ip = req.headers.get("cf-connecting-ip") ?? "local";

    if (action === "ws") return stub.fetch(req);
    if (action === "call/tts") {
      // Streams speech so playback can start on the first bytes.
      const text = (url.searchParams.get("text") ?? "").slice(0, 600);
      if (!text.trim()) return new Response("", { status: 400 });
      if (!(await stub.callActive(url.searchParams.get("callId") ?? ""))) return new Response("", { status: 409 });
      const { success } = await env.MSG_LIMIT.limit({ key: `tts:${ip}` });
      if (!success) return new Response("", { status: 429 });
      try {
        const audio = await speakStream(env, text);
        return new Response(audio, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
      } catch (e) {
        console.warn("tts failed", String(e));
        return new Response("", { status: 502 });
      }
    }
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    switch (action) {
      case "init": {
        const snap = await stub.init(id);
        // Warm up the voice agent so the first call does not pay for provisioning.
        if (elevenLabsConfigured(env)) ctx.waitUntil(registry(env).ensure().catch((e) => console.warn("voice warmup", String(e))));
        return json(snap);
      }
      case "start": {
        const { success } = await env.CALL_LIMIT.limit({ key: ip });
        if (!success) return json({ error: "rate_limited" }, 429);
        return json(await stub.start());
      }
      case "message": {
        const { success } = await env.MSG_LIMIT.limit({ key: `${ip}` });
        if (!success) return json({ error: "rate_limited" }, 429);
        const b = await body<{ text: string }>(req);
        if (typeof b.text !== "string") return json({ error: "bad_request" }, 400);
        // The reply arrives over the WebSocket; keep the request short.
        ctx.waitUntil(stub.userMessage(b.text));
        return json({ ok: true });
      }
      case "call/request": {
        const { success } = await env.CALL_LIMIT.limit({ key: ip });
        if (!success) return json({ error: "rate_limited" }, 429);
        return json(await stub.requestCall());
      }
      case "call/answer": {
        const { success } = await env.CALL_LIMIT.limit({ key: ip });
        if (!success) return json({ error: "rate_limited" }, 429);
        const b = await body<{ callId: string; transport: string }>(req);
        const transport = b.transport === "websocket" || b.transport === "local" ? b.transport : "webrtc";
        return json(await stub.answer(String(b.callId ?? ""), transport));
      }
      case "call/turn": {
        // One spoken turn on the built-in voice path. Body is the user's audio (WAV), or empty for non-speech turns.
        const { success } = await env.MSG_LIMIT.limit({ key: `turn:${ip}` });
        if (!success) return json({ ok: false, error: "rate_limited" }, 429);
        const callId = url.searchParams.get("callId") ?? "";
        const kind = url.searchParams.get("kind") ?? "user";
        let text = url.searchParams.get("text") ?? "";
        let heard = "";
        const t0 = Date.now();
        if (kind === "user" && !text) {
          const type = req.headers.get("content-type") ?? "audio/wav";
          const buf = await req.arrayBuffer();
          if (buf.byteLength < 2000) return json({ ok: false, error: "empty_audio" });
          if (buf.byteLength > 3_000_000) return json({ ok: false, error: "too_long" }, 413);
          try {
            heard = await transcribe(env, buf, type);
          } catch (e) {
            console.warn("stt failed", String(e));
            return json({ ok: false, error: "stt_failed" });
          }
          if (!heard) return json({ ok: false, error: "no_speech" });
          text = heard;
        }
        const t1 = Date.now();
        const r = await stub.localTurn(callId, kind === "start" || kind === "silence" || kind === "context" ? kind : "user", text.slice(0, 1500));
        if (!r.ok || !r.say) return json({ ...r, heard });
        console.log(`turn ${kind}: stt ${t1 - t0}ms, think ${Date.now() - t1}ms`);
        return json({ ok: true, heard, say: r.say, end: r.end });
      }
      case "call/decline": {
        const b = await body<{ callId: string }>(req);
        return json(await stub.decline(String(b.callId ?? "")));
      }
      case "call/end": {
        const b = await body<{ callId: string; reason: string; transcript: { role: "user" | "agent"; text: string }[]; detail?: string }>(req);
        const reason = b.reason === "agent" || b.reason === "user" || b.reason === "failed" ? b.reason : "error";
        const transcript = Array.isArray(b.transcript)
          ? b.transcript.filter((t) => t && (t.role === "user" || t.role === "agent") && typeof t.text === "string")
          : [];
        ctx.waitUntil(stub.endCall(String(b.callId ?? ""), reason, transcript, typeof b.detail === "string" ? b.detail.slice(0, 200) : undefined));
        return json({ ok: true });
      }
      case "tool": {
        const b = await body<{ name: string; args: Record<string, unknown> }>(req);
        return json({ result: await stub.tool(String(b.name ?? ""), b.args && typeof b.args === "object" ? b.args : {}) });
      }
      case "gmail/connect": {
        const b = await body<{ email: string }>(req);
        const r = await stub.gmailConnect(String(b.email ?? ""));
        return json(r, r.ok ? 200 : 400);
      }
      case "gmail/cancel":
        return json(await stub.gmailCancel());
      case "reset":
        await stub.reset();
        return json({ ok: true });
      default:
        return json({ error: "not_found" }, 404);
    }
  },
} satisfies ExportedHandler<Env>;
