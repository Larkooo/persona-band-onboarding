import { useState } from "react";
import type { CallRecord, SessionState } from "../../shared/types";
import { DEFAULT_AGENT_NAME, missingFields } from "../../shared/types";
import { CheckIcon, ChevronIcon } from "./icons";

function callLabel(c: CallRecord) {
  const secs = c.answeredAt && c.endedAt ? Math.round((c.endedAt - c.answeredAt) / 1000) : 0;
  const dur = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  switch (c.outcome) {
    case "completed":
      return `Call ${dur}`;
    case "hung_up":
      return `Hung up ${dur}`;
    case "dropped":
      return `Dropped ${dur}`;
    case "declined":
      return "Declined";
    case "missed":
      return "Missed";
    default:
      return "Failed";
  }
}

/** Tester-facing view of what the assistant has learned. */
export function Insights({ state, onReset }: { state: SessionState | null; onReset(): void }) {
  const [open, setOpen] = useState(() => (typeof window !== "undefined" ? window.innerWidth > 820 : true));
  if (!state) return null;
  const p = state.profile;
  const gmail =
    p.gmail.status === "connected"
      ? p.gmail.address
      : state.declined.gmail
        ? "Skipped for now"
        : p.gmail.status === "link_sent"
          ? "Link sent"
          : null;
  const rows: [string, string | null][] = [
    ["Assistant name", p.agentName],
    ["Your name", p.userName],
    ["Help with", p.helpWith],
    ["Gmail", gmail],
  ];
  const done = 4 - missingFields({ ...state, declined: { ...state.declined, gmail: false } }).length;
  const status = state.graduated ? (state.graduatedEarly ? "Finished early" : "Complete") : `${done} of 4`;

  return (
    <aside className={`insights glass ${open ? "open" : ""}`}>
      <button className="insights-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="insights-title">What {p.agentName ?? DEFAULT_AGENT_NAME} knows</span>
        <span className={`pill ${state.graduated ? "pill-done" : ""}`}>{status}</span>
        <ChevronIcon className="chev" />
      </button>
      {open && (
        <div className="insights-body">
          <dl>
            {rows.map(([k, v]) => (
              <div key={k} className={`row ${v ? "has" : ""}`}>
                <dt>
                  <span className="tick">{v ? <CheckIcon size={11} /> : null}</span>
                  {k}
                </dt>
                <dd>{v ?? "Not yet"}</dd>
              </div>
            ))}
            {p.phone && (
              <div className="row has">
                <dt>
                  <span className="tick">
                    <CheckIcon size={11} />
                  </span>
                  Phone
                </dt>
                <dd>{p.phone}</dd>
              </div>
            )}
          </dl>
          {state.call.history.length > 0 && (
            <div className="calls">
              {state.call.history.map((c) => (
                <span key={c.id} className={`chip chip-${c.outcome}`}>
                  {callLabel(c)}
                </span>
              ))}
            </div>
          )}
          {!state.voiceAvailable && <p className="note">Voice calls are turned off on this deployment, so everything happens by text.</p>}
          <button className="btn ghost small" onClick={onReset}>
            Start over
          </button>
        </div>
      )}
    </aside>
  );
}
