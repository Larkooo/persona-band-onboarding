// Built-in voice path on Workers AI: speech to text, the call brain, and text to speech.
// Used when ElevenLabs is not configured or fails, so a call always works.
import type { ChatMessage, SessionState } from "../shared/types";
import { callPrompt } from "./voice";

const STT_MODEL = "@cf/deepgram/nova-3";
const TTS_MODEL = "@cf/deepgram/aura-2-en";

export interface VoiceTurn {
  say: string;
  user_name: string | null;
  help_with: string | null;
  send_gmail_link: boolean;
  decline_gmail: boolean;
  end_call: boolean;
}

const OUTPUT = `

# How to respond
You are speaking through a voice pipeline without tools. Wherever the instructions above mention a tool, set the matching field instead. Reply with a single JSON object and nothing else:
{"say": string, "user_name": string or null, "help_with": string or null, "send_gmail_link": boolean, "decline_gmail": boolean, "end_call": boolean}
- say: exactly what you say next. At most two short spoken sentences, under 35 words in total.
- user_name: set when they just told you their name (replaces save_user_name).
- help_with: a short summary when they just told you something they want help with (replaces save_help_request).
- send_gmail_link: true to send the Connect Gmail link now (replaces send_gmail_link). Your "say" should tell them it just arrived in their messages.
- decline_gmail: true if they just said they do not want to connect Gmail (replaces decline_gmail).
- end_call: true when "say" is your goodbye, or they asked to stop (replaces end_call).
Lines from the user in brackets, like "[note: ...]", describe something that happened during the call. They are not speech. React to them naturally.`;

const SCHEMA = {
  type: "object",
  properties: {
    say: { type: "string" },
    user_name: { type: ["string", "null"] },
    help_with: { type: ["string", "null"] },
    send_gmail_link: { type: "boolean" },
    decline_gmail: { type: "boolean" },
    end_call: { type: "boolean" },
  },
  required: ["say", "user_name", "help_with", "send_gmail_link", "decline_gmail", "end_call"],
};

function parse(raw: unknown): VoiceTurn | null {
  let j: any = raw;
  if (typeof raw === "string") {
    const a = raw.indexOf("{");
    const b = raw.lastIndexOf("}");
    if (a < 0 || b < a) return null;
    try {
      j = JSON.parse(raw.slice(a, b + 1));
    } catch {
      return null;
    }
  }
  if (!j || typeof j.say !== "string" || !j.say.trim()) return null;
  const s = (v: unknown) => (typeof v === "string" && v.trim() && !/^(null|none|unknown)$/i.test(v.trim()) ? v.trim() : null);
  return {
    say: j.say.trim().replace(/\s*—\s*/g, ", ").slice(0, 600),
    user_name: s(j.user_name),
    help_with: s(j.help_with),
    send_gmail_link: j.send_gmail_link === true,
    decline_gmail: j.decline_gmail === true,
    end_call: j.end_call === true,
  };
}

export async function voiceThink(
  env: Env,
  state: SessionState,
  messages: ChatMessage[],
  transcript: { role: "user" | "agent"; text: string }[],
): Promise<VoiceTurn> {
  const system = callPrompt(state, messages).prompt + OUTPUT;
  const turns: { role: "system" | "user" | "assistant"; content: string }[] = [{ role: "system", content: system }];
  turns.push({ role: "user", content: "[call connected]" });
  for (const t of transcript.slice(-30)) {
    const role = t.role === "agent" ? "assistant" : "user";
    const prev = turns[turns.length - 1];
    if (prev.role === role) prev.content += `\n${t.text}`;
    else turns.push({ role, content: t.text });
  }
  for (const model of [env.TEXT_MODEL, "@cf/deepseek-ai/deepseek-v4-flash-0731"]) {
    try {
      const out: any = await Promise.race([
        (env.AI as any).run(model, {
          messages: turns,
          max_tokens: 220,
          temperature: 0.5,
          chat_template_kwargs: { enable_thinking: false },
          response_format: { type: "json_schema", json_schema: SCHEMA },
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000)),
      ]);
      const raw = out?.response ?? out?.choices?.[0]?.message?.content;
      const r = parse(raw);
      if (r) return r;
      console.warn("voiceThink unparseable", model, JSON.stringify(out).slice(0, 300));
    } catch (e) {
      console.warn("voiceThink error", model, String(e));
    }
  }
  return {
    say: "Sorry, I lost you for a second. Could you say that again?",
    user_name: null,
    help_with: null,
    send_gmail_link: false,
    decline_gmail: false,
    end_call: false,
  };
}

export async function transcribe(env: Env, audio: ArrayBuffer, contentType: string): Promise<string> {
  const out: any = await (env.AI as any).run(STT_MODEL, {
    audio: { body: new Response(audio).body, contentType },
    smart_format: true,
    punctuate: true,
    language: "en",
  });
  return String(out?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "").trim();
}

/** MP3 stream for a line of speech. */
export async function speakStream(env: Env, text: string): Promise<ReadableStream | Uint8Array> {
  const out: any = await (env.AI as any).run(TTS_MODEL, { text, speaker: env.LOCAL_VOICE || "athena", encoding: "mp3" });
  if (out instanceof ReadableStream || out instanceof Uint8Array) return out;
  if (out instanceof ArrayBuffer) return new Uint8Array(out);
  if (typeof out?.audio === "string") return Uint8Array.from(atob(out.audio), (c) => c.charCodeAt(0));
  throw new Error("unexpected tts output");
}
