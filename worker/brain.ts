import type { ChatMessage, SessionState } from "../shared/types";
import { missingFields } from "../shared/types";
import { extractionPrompt, textSystemPrompt } from "./prompts";

export type BrainAction = "none" | "call" | "stop_call" | "gmail_link" | "finish_onboarding";
const ACTIONS: BrainAction[] = ["none", "call", "stop_call", "gmail_link", "finish_onboarding"];

export interface BrainResult {
  updates: {
    agent_name: string | null;
    user_name: string | null;
    phone: string | null;
    help_with: string | null;
    email: string | null;
  };
  declined: { call: boolean; gmail: boolean };
  action: BrainAction;
  replies: string[];
  fallback?: boolean;
}

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    updates: {
      type: "object",
      properties: {
        agent_name: { type: ["string", "null"] },
        user_name: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
        help_with: { type: ["string", "null"] },
        email: { type: ["string", "null"] },
      },
      required: ["agent_name", "user_name", "phone", "help_with", "email"],
    },
    declined: {
      type: "object",
      properties: { call: { type: "boolean" }, gmail: { type: "boolean" } },
      required: ["call", "gmail"],
    },
    action: { type: "string", enum: ACTIONS },
    replies: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
  },
  required: ["updates", "declined", "action", "replies"],
};

type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

/** Turn the thread into chat turns. Events and call logs become "[event]" user turns. */
function toTurns(messages: ChatMessage[]): LlmMessage[] {
  const turns: LlmMessage[] = [];
  for (const m of messages.slice(-40)) {
    let role: LlmMessage["role"];
    let content: string;
    if (m.role === "user") {
      role = "user";
      content = m.text;
    } else if (m.role === "assistant" && m.kind === "text") {
      role = "assistant";
      content = m.text;
    } else if (m.kind === "gmail_card") {
      role = "assistant";
      content = "(sent the secure Gmail connect link)";
    } else if (m.role === "system" && typeof m.meta?.event === "string") {
      role = "user";
      content = `[event] ${m.meta.event}`;
    } else continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) prev.content += `\n${content}`;
    else turns.push({ role, content });
  }
  if (turns[0]?.role === "assistant") turns.unshift({ role: "user", content: "[event] The conversation started." });
  return turns;
}

function parseJson(raw: unknown): any {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  let t = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try {
    return JSON.parse(t.slice(a, b + 1));
  } catch {
    return null;
  }
}

function extractResponse(out: any): unknown {
  if (!out) return null;
  if (typeof out.response !== "undefined") return out.response;
  const choice = out.choices?.[0]?.message;
  if (choice) return choice.content ?? choice.reasoning_content ?? null;
  return out;
}

const str = (v: unknown, max = 200): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t || /^(null|none|unknown|n\/a)$/i.test(t)) return null;
  return t.slice(0, max);
};

function normalize(j: any): BrainResult | null {
  if (!j || typeof j !== "object") return null;
  const replies = (Array.isArray(j.replies) ? j.replies : [j.replies])
    .map((r: unknown) => (typeof r === "string" ? r.trim() : ""))
    .filter(Boolean)
    .slice(0, 3)
    .map((r: string) => r.replace(/\s*—\s*/g, ", ").replace(/–/g, "-"));
  if (!replies.length) return null;
  const u = j.updates ?? {};
  let action: BrainAction = ACTIONS.includes(j.action) ? j.action : "none";
  // Guard: a reply that is still asking for the number must not start the call.
  if (action === "call" && /\bnumber\b[^.?!]*\?/i.test(replies.join(" "))) action = "none";
  return {
    updates: {
      agent_name: str(u.agent_name, 40),
      user_name: str(u.user_name, 40),
      phone: str(u.phone, 40),
      help_with: str(u.help_with, 240),
      email: str(u.email, 120),
    },
    declined: { call: j.declined?.call === true, gmail: j.declined?.gmail === true },
    action,
    replies,
  };
}

async function runModel(env: Env, model: string, messages: LlmMessage[], schema: object | null, maxTokens: number) {
  const input: Record<string, unknown> = {
    messages,
    max_tokens: maxTokens,
    temperature: 0.5,
    chat_template_kwargs: { enable_thinking: false },
  };
  if (schema) input.response_format = { type: "json_schema", json_schema: schema };
  return (env.AI as any).run(model, input);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

export async function think(env: Env, state: SessionState, messages: ChatMessage[]): Promise<BrainResult> {
  const prompt: LlmMessage[] = [{ role: "system", content: textSystemPrompt(state) }, ...toTurns(messages)];
  const models = [env.TEXT_MODEL, "@cf/deepseek-ai/deepseek-v4-flash-0731"];
  for (const model of models) {
    for (const schema of [RESULT_SCHEMA, null]) {
      try {
        const out = await withTimeout(runModel(env, model, prompt, schema, 700), 20000);
        const r = normalize(parseJson(extractResponse(out)));
        if (r) return r;
        console.warn("brain: unparseable output", model, JSON.stringify(out).slice(0, 400));
      } catch (e) {
        console.warn("brain: model error", model, String(e));
      }
    }
  }
  return fallback(state);
}

/** Deterministic reply used only when every model call fails. */
export function fallback(state: SessionState): BrainResult {
  const next = missingFields(state)[0];
  const replies: Record<string, string> = {
    agentName: "Sorry, I lost my train of thought for a second. What would you like to call me?",
    userName: "Sorry, I lost my train of thought for a second. What should I call you?",
    helpWith: "Sorry, I lost my train of thought for a second. What is one thing I could take off your plate this week?",
    gmail: "Sorry, I lost my train of thought for a second. Would you like to connect your Gmail so I can help with email?",
  };
  return {
    updates: { agent_name: null, user_name: null, phone: null, help_with: null, email: null },
    declined: { call: false, gmail: false },
    action: "none",
    replies: [next ? replies[next] : "Sorry, I lost my train of thought for a second. Could you say that again?"],
    fallback: true,
  };
}

export interface CallExtraction {
  user_name: string | null;
  help_with: string | null;
  email: string | null;
  declined_gmail: boolean;
  wants_to_stop: boolean;
  summary: string | null;
}

/** Safety net after a call: pull facts from the transcript in case the voice agent missed a tool call. */
export async function extractFromTranscript(
  env: Env,
  transcript: { role: string; text: string }[],
): Promise<CallExtraction | null> {
  if (!transcript.some((t) => t.role === "user")) return null;
  const text = transcript.map((t) => `${t.role === "agent" ? "Assistant" : "User"}: ${t.text}`).join("\n").slice(-8000);
  try {
    const out = await withTimeout(
      runModel(env, env.TEXT_MODEL, [
        { role: "system", content: extractionPrompt() },
        { role: "user", content: text },
      ], null, 400),
      15000,
    );
    const j = parseJson(extractResponse(out));
    if (!j) {
      console.warn("extract: unparseable", JSON.stringify(out).slice(0, 400));
      return null;
    }
    return {
      user_name: str(j.user_name, 40),
      help_with: str(j.help_with, 240),
      email: str(j.email, 120),
      declined_gmail: j.declined_gmail === true,
      wants_to_stop: j.wants_to_stop === true,
      summary: str(j.summary, 400),
    };
  } catch (e) {
    console.warn("extract failed", String(e));
    return null;
  }
}
