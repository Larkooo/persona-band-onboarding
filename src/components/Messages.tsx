import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DEFAULT_AGENT_NAME, type ChatMessage, type SessionState } from "../../shared/types";
import { CheckIcon, LockIcon, MailIcon, PhoneIcon, SendIcon } from "./icons";
import { Orb } from "./Orb";

interface Props {
  state: SessionState | null;
  messages: ChatMessage[];
  typing: boolean;
  online: boolean;
  onCall?: boolean;
  onSend(text: string): void;
  onRequestCall(): void;
  onOpenGmail(): void;
  /** Mobile: tapping the header expands or collapses the sheet during a call. */
  onHeaderTap?(): void;
}

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function dayLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return `${same ? "Today" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time(ts)}`;
}

function callLabel(m: ChatMessage) {
  const secs = Number(m.meta?.seconds ?? 0);
  if (m.text === "Call" && secs) return `Call ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  return m.text;
}

export function Messages({ state, messages, typing, online, onCall, onSend, onRequestCall, onOpenGmail, onHeaderTap }: Props) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const name = state?.profile.agentName ?? null;
  const gmail = state?.profile.gmail;
  const canCall = !!state?.voiceAvailable && state.call.phase === "idle" && !onCall;

  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages.length, typing]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [draft]);

  const submit = () => {
    const t = draft.trim();
    if (!t) return;
    onSend(t);
    setDraft("");
  };

  let lastTs = 0;
  return (
    <section className="messages glass" aria-label="Messages">
      <header className="messages-head">
        <Orb name={name} size={40} />
        <div className="messages-title" onClick={onHeaderTap}>
          <div className="messages-name">{name ?? DEFAULT_AGENT_NAME}</div>
          <div className="messages-sub">{online ? (onCall ? "On a call" : name ? "Persona" : "New assistant") : "Reconnecting"}</div>
        </div>
        {state?.voiceAvailable && (
          <button className="icon-btn" onClick={onRequestCall} disabled={!canCall} aria-label="Ask for a call" title="Ask for a call">
            <PhoneIcon size={18} />
          </button>
        )}
      </header>

      <div className="messages-list" ref={listRef}>
        {messages.map((m) => {
          const showDay = m.ts - lastTs > 15 * 60 * 1000;
          lastTs = m.ts;
          return (
            <div key={m.id} className="msg-row-wrap">
              {showDay && <div className="day">{dayLabel(m.ts)}</div>}
              {m.kind === "text" && (
                <div className={`msg-row ${m.role === "user" ? "me" : "them"}`}>
                  <div className={`bubble ${m.role === "user" ? "bubble-me" : "bubble-them"}`}>{m.text}</div>
                  {m.meta?.failed ? (
                    <div className="failed">{m.meta.failed === "rate" ? "Not delivered. Too many messages." : "Not delivered"}</div>
                  ) : null}
                </div>
              )}
              {m.kind === "gmail_card" && (
                <div className="msg-row them">
                  <button className="gmail-card" onClick={onOpenGmail} disabled={gmail?.status === "connected"}>
                    <span className="gmail-card-icon">
                      <MailIcon size={22} />
                    </span>
                    <span className="gmail-card-text">
                      <span className="gmail-card-title">Connect Gmail</span>
                      <span className="gmail-card-sub">
                        {gmail?.status === "connected" ? (
                          <>
                            <CheckIcon size={12} /> Connected
                          </>
                        ) : (
                          <>
                            <LockIcon size={12} /> Secure link
                          </>
                        )}
                      </span>
                    </span>
                  </button>
                </div>
              )}
              {m.kind === "call_log" && (
                <div className={`call-log ${m.meta?.outcome === "missed" || m.meta?.outcome === "failed" ? "warn" : ""}`}>
                  <PhoneIcon size={13} />
                  <span>{callLabel(m)}</span>
                  <span className="call-log-time">{time(m.ts)}</span>
                </div>
              )}
              {m.kind === "divider" && (
                <div className="divider">
                  <span>{m.text}</span>
                </div>
              )}
            </div>
          );
        })}
        {typing && (
          <div className="msg-row them">
            <div className="bubble bubble-them typing" aria-label="Typing">
              <i />
              <i />
              <i />
            </div>
          </div>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          maxLength={1500}
          placeholder={onCall ? "Type to the call" : "Message"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Message"
        />
        <button type="submit" className="send" disabled={!draft.trim()} aria-label="Send">
          <SendIcon />
        </button>
      </form>
    </section>
  );
}
