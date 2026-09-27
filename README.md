# Persona Band onboarding

Prototype onboarding for a personal assistant that lives in your messages and on a wearable. The user presses Start, the assistant calls their Persona Band, and after the call the conversation continues by text.

Live: https://onboarding.nasrdjegh.com

## What it collects

| Item | Where |
| --- | --- |
| A name for the assistant | Text, right after the call |
| The user's name | Call, or text if the call does not happen |
| Something they want help with | Call, or text |
| A connected Gmail | Call (link sent into the thread mid-call), or text |

If the call is declined, missed or cut short, the same items are collected by text. A number is never required; the user can also ask for a call again at any time.

## How it stays on track

- **Plan in code, words from the model.** Each turn the Worker builds an ordered plan with `[done]` and `[todo]` items from session state (`worker/prompts.ts`). The model works on the first open item, records anything the user volunteers in any order, and returns JSON (`updates`, `declined`, `action`, `replies`). Code validates and applies it.
- **Early graduation.** If the user states a need or wants to skip ahead, the assistant helps immediately and sets `finish_onboarding`. Missing items are asked for later, only when a task needs them.
- **Refusals stick.** Declining the call or Gmail is recorded and never pushed again unless the user brings it up.
- **Off-topic and injection.** Short answer, then back to the plan. Role-change attempts are ignored.
- **Rapid-fire texts** are debounced and answered once.
- **Only the user can start a call.** Follow-ups to events (missed, dropped) can offer a call back but never place one.

## Call lifecycle

Every ending funnels into one path in the session Durable Object (`worker/session.ts`), which logs the call in the thread and has the text brain follow up:

| Outcome | Trigger |
| --- | --- |
| completed | Agent wraps up and calls `end_call` |
| hung_up | User ends the call early |
| declined | User declines while ringing |
| missed | No answer within 30 s (DO alarm) |
| dropped | Heartbeat stops (tab closed, network lost), page reload, time limit |
| failed | Mic blocked, voice service error or quota |

After any call with speech, the transcript is run through an extraction pass, so facts the voice agent heard but did not save still land. Texts typed during a call are forwarded into the call as the user's turn, and connecting Gmail mid-call is announced to the voice agent as a contextual update.

## Stack

- Cloudflare Worker + Durable Objects (one per session, one registry for the voice agent), static assets, rate limiting
- Text brain: Workers AI `@cf/zai-org/glm-5.3-flash`, falling back to `@cf/deepseek-ai/deepseek-v4-flash-0731`, then a deterministic reply
- Voice: ElevenLabs Agents over WebRTC. The agent and its client tools are created and kept in sync from `worker/voice.ts` on first use. Each call gets a prompt and first message built from the session.
- Voice fallback: when ElevenLabs is missing or fails, calls run on Workers AI (Deepgram nova-3 speech to text, the same brain, streamed Deepgram aura-2 speech) with voice activity detection and barge-in in the browser (`src/lib/localVoice.ts`, `worker/localvoice.ts`)
- Web: React and a liquid glass UI. The band is Persona's product film (`public/band`), cut into segments (rise, ring on, finger tap, green ring) and multiplied onto a CSS sky (`src/film/BandFilm.ts`).

## Setup

```bash
npm install
./scripts/fetch-band-footage.sh               # Persona's band film, not committed here (needs ffmpeg)
npx wrangler secret put ELEVENLABS_API_KEY   # optional: ElevenLabs voice; without it calls use the built-in Workers AI voice
npm run deploy
```

Local development:

```bash
npx vite --port 5288
```

`bench/` holds a small harness for comparing text models on tricky turns (`bench/run.sh <model>`).
