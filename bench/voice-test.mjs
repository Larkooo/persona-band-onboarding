// Drives the real ElevenLabs voice agent in text-only mode through the public API, to check its tool use
// without a microphone. Usage: BASE=https://onboarding.nasrdjegh.com node bench/voice-test.mjs "turn 1" "turn 2" ...
// A turn "@gmail you@gmail.com" connects Gmail through the sheet endpoint; "@hangup" ends the call as the user.
const base = process.env.BASE ?? "http://localhost:5288";
const id = crypto.randomUUID().replace(/-/g, "");
const post = (a, b) =>
  fetch(`${base}/api/s/${id}/${a}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then((r) =>
    r.json(),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

await post("init");
const sws = new WebSocket(base.replace("http", "ws") + `/api/s/${id}/ws`);
let state;
const pushed = [];
sws.onmessage = (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === "state") state = ev.state;
  if (ev.type === "snapshot") state = ev.state;
  pushed.push(ev);
};
await new Promise((r) => (sws.onopen = r));
await post("message", { text: process.env.AGENT_NAME ?? "Call yourself Nova" });
await sleep(6000);
const req = await post("call/request");
if (!req.ok) throw new Error(`call/request: ${JSON.stringify(req)}`);
await sleep(500);
const callId = state.call.current.id;
const ans = await post("call/answer", { callId, transport: "websocket" });
if (!ans.ok) throw new Error(`answer: ${JSON.stringify(ans)}`);
const hb = setInterval(() => sws.send(JSON.stringify({ type: "heartbeat", callId })), 8000);

const transcript = [];
const ws = new WebSocket(ans.join.signedUrl);
let agentTurnDone;
let ended = null;
ws.onopen = () =>
  ws.send(
    JSON.stringify({
      type: "conversation_initiation_client_data",
      conversation_config_override: {
        agent: { prompt: { prompt: ans.join.prompt }, first_message: ans.join.firstMessage },
        conversation: { text_only: true },
      },
    }),
  );
ws.onmessage = async (e) => {
  const ev = JSON.parse(e.data);
  switch (ev.type) {
    case "ping":
      ws.send(JSON.stringify({ type: "pong", event_id: ev.ping_event.event_id }));
      break;
    case "agent_response":
      log(`  AGENT: ${ev.agent_response_event.agent_response}`);
      transcript.push({ role: "agent", text: ev.agent_response_event.agent_response });
      clearTimeout(agentTurnDone?.t);
      if (agentTurnDone) agentTurnDone.t = setTimeout(agentTurnDone.resolve, 2500);
      break;
    case "client_tool_call": {
      const t = ev.client_tool_call;
      log(`  TOOL ${t.tool_name}(${JSON.stringify(t.parameters)})`);
      const r = await post("tool", { name: t.tool_name, args: t.parameters });
      log(`     -> ${r.result}`);
      ws.send(JSON.stringify({ type: "client_tool_result", tool_call_id: t.tool_call_id, result: r.result, is_error: false }));
      break;
    }
    case "agent_tool_response":
      if (ev.agent_tool_response?.tool_name === "end_call") log("  [agent called end_call]");
      break;
    case "error":
      log("  ERROR", JSON.stringify(ev));
      break;
  }
};
ws.onclose = (e) => {
  ended = ended ?? { reason: "agent", code: e.code, why: e.reason };
  agentTurnDone?.resolve();
};
const waitAgent = () =>
  new Promise((resolve) => {
    agentTurnDone = { resolve, t: setTimeout(resolve, 20000) };
  });

await waitAgent();
for (const turn of process.argv.slice(2)) {
  if (ended) break;
  if (turn.startsWith("@gmail")) {
    const email = turn.split(" ")[1];
    log(`  (user connects Gmail as ${email})`);
    const r = await post("gmail/connect", { email });
    if (r.ok) {
      const ctx = pushed.filter((p) => p.type === "call_context").pop();
      if (ctx) ws.send(JSON.stringify({ type: "contextual_update", text: ctx.text }));
    } else log(`     -> ${r.error}`);
    await waitAgent();
    continue;
  }
  if (turn === "@hangup") {
    ended = { reason: "user" };
    ws.close();
    break;
  }
  log(`  USER: ${turn}`);
  transcript.push({ role: "user", text: turn });
  ws.send(JSON.stringify({ type: "user_message", text: turn }));
  await waitAgent();
}
if (!ended) {
  ended = { reason: "user", note: "script ran out of turns" };
  ws.close();
}
clearInterval(hb);
log(`  call ended: ${JSON.stringify(ended)}`);
await post("call/end", { callId, reason: ended.reason === "agent" ? "agent" : "user", transcript });
await sleep(9000);
for (const ev of pushed) if (ev.type === "message" && ev.message.role !== "user") log(`  THREAD ${ev.message.kind}: ${ev.message.text}`);
const p = state.profile;
log("STATE:", JSON.stringify({ agent: p.agentName, user: p.userName, help: p.helpWith, gmail: p.gmail, declined: state.declined, grad: state.graduated }));
sws.close();
process.exit(0);
