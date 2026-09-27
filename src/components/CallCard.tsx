import { forwardRef, useEffect, useState } from "react";
import { DEFAULT_AGENT_NAME } from "../../shared/types";
import type { CallView } from "../lib/call";
import { HangupIcon, MicIcon, MicOffIcon, PhoneIcon } from "./icons";
import { Orb } from "./Orb";

interface Props {
  view: CallView;
  name: string | null;
  onAccept(): void;
  onDecline(): void;
  onHangUp(): void;
  onMute(m: boolean): void;
}

function useClock(startedAt: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [startedAt]);
  if (!startedAt) return "0:00";
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Floating glass card beside the band. Its position is driven every frame by the parent via the forwarded ref. */
export const CallCard = forwardRef<HTMLDivElement, Props>(function CallCard({ view, name, onAccept, onDecline, onHangUp, onMute }, ref) {
  const clock = useClock(view.phase === "active" ? view.startedAt : null);
  const shown = view.phase !== "idle";
  const who = name ?? DEFAULT_AGENT_NAME;

  return (
    <div ref={ref} className={`call-card-anchor ${shown ? "shown" : ""}`} aria-live="polite">
      {shown && (
        <div className={`call-card glass phase-${view.phase}`} role="dialog" aria-label={`Call with ${who}`}>
          <div className="call-top">
            <Orb name={name} size={44} pulse={view.phase === "ringing"} />
            <div className="call-who">
              <div className="call-name">{who}</div>
              <div className="call-status">
                {view.error
                  ? "Call failed"
                  : view.phase === "ringing"
                    ? "Incoming call"
                    : view.phase === "connecting"
                      ? "Connecting"
                      : view.phase === "ended"
                        ? "Call ended"
                        : view.muted
                          ? `${clock}  Muted`
                          : clock}
              </div>
            </div>
            {view.phase === "active" && <Bars speaking={view.speaking} />}
          </div>

          {view.error && <p className="call-error">{view.error}</p>}

          {view.phase === "active" && (
            <p className={`caption ${view.caption ? "" : "caption-empty"}`}>
              {view.caption ? view.caption.text : "Listening"}
            </p>
          )}

          {view.phase === "ringing" && (
            <div className="call-actions">
              <button className="round decline" onClick={onDecline} aria-label="Decline">
                <HangupIcon />
              </button>
              <button className="round accept" onClick={onAccept} aria-label="Accept" autoFocus>
                <PhoneIcon size={24} />
              </button>
            </div>
          )}
          {(view.phase === "active" || view.phase === "connecting") && !view.error && (
            <div className="call-actions">
              <button
                className={`round mute ${view.muted ? "on" : ""}`}
                onClick={() => onMute(!view.muted)}
                disabled={view.phase !== "active"}
                aria-label={view.muted ? "Unmute" : "Mute"}
              >
                {view.muted ? <MicOffIcon /> : <MicIcon />}
              </button>
              <button className="round decline" onClick={onHangUp} aria-label="End call">
                <HangupIcon />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

function Bars({ speaking }: { speaking: CallView["speaking"] }) {
  return (
    <span className={`bars bars-${speaking}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
