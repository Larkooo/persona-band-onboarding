import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_AGENT_NAME, type ChatMessage } from "../shared/types";
import { CallCard } from "./components/CallCard";
import { GmailSheet } from "./components/GmailSheet";
import { MailIcon } from "./components/icons";
import { Insights } from "./components/Insights";
import { Messages } from "./components/Messages";
import { createBandFilm, type BandFilm, type BandMode } from "./film/BandFilm";
import { CallController, type CallView } from "./lib/call";
import { useSession } from "./lib/session";
import { playConnect, playHangup, playMessage, startRingtone, stopRingtone, unlockAudio } from "./lib/sounds";

const MOBILE = 820;

export default function App() {
  const session = useSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const call = useMemo(() => new CallController(() => sessionRef.current), []);
  const [view, setView] = useState<CallView>(call.view);
  const [gmailOpen, setGmailOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [banner, setBanner] = useState<ChatMessage | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const ringHitRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const filmRef = useRef<BandFilm | null>(null);
  const { state, messages } = session;
  const started = !!state?.started || starting;
  const inCall = view.phase === "ringing" || view.phase === "connecting" || view.phase === "active";

  useEffect(() => call.on(setView), [call]);
  useEffect(() => call.attach(), [call]);

  // Audio needs a gesture before the first ring.
  useEffect(() => {
    const once = () => unlockAudio();
    window.addEventListener("pointerdown", once, { once: true });
    window.addEventListener("keydown", once, { once: true });
    return () => {
      window.removeEventListener("pointerdown", once);
      window.removeEventListener("keydown", once);
    };
  }, []);

  // The band film.
  useEffect(() => {
    if (!stageRef.current) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const film = createBandFilm(stageRef.current, { reducedMotion: reduced });
    filmRef.current = film;
    return () => {
      film.dispose();
      filmRef.current = null;
    };
  }, []);

  // Keep the band framed in whatever the panels leave visible.
  useEffect(() => {
    const update = () => {
      const panel = panelRef.current;
      const mobile = window.innerWidth <= MOBILE;
      const shown = document.body.classList.contains("started");
      const rect = panel?.getBoundingClientRect();
      const right = shown && !mobile && rect ? window.innerWidth - rect.left : 0;
      const bottom = shown && mobile && rect ? Math.max(0, window.innerHeight - rect.top) : 0;
      filmRef.current?.setSafeArea({ right, bottom });
    };
    update();
    const ro = new ResizeObserver(update);
    if (panelRef.current) ro.observe(panelRef.current);
    window.addEventListener("resize", update);
    const t = setInterval(update, 250);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    document.body.classList.toggle("started", started);
  }, [started]);

  // Per frame: audio levels into the band, and the call card follows the band.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const lv = call.sample();
      const film = filmRef.current;
      film?.setLevels(lv.agent, lv.user);
      const ring0 = film?.getRingScreenPosition();
      const hit = ringHitRef.current;
      if (hit && ring0) {
        const size = Math.max(64, ring0.radius * 3);
        hit.style.transform = `translate3d(${(ring0.x - size / 2).toFixed(1)}px, ${(ring0.y - size / 2).toFixed(1)}px, 0)`;
        hit.style.width = hit.style.height = `${size}px`;
      }
      const card = cardRef.current;
      if (!card || call.view.phase === "idle") return;
      const mobile = window.innerWidth <= MOBILE;
      const panel = panelRef.current?.getBoundingClientRect();
      const visW = mobile || !panel ? window.innerWidth : panel.left;
      const visH = mobile && panel ? Math.min(window.innerHeight, panel.top) : window.innerHeight;
      const w = card.offsetWidth || 320;
      const h = card.offsetHeight || 160;
      const ring = film?.getRingScreenPosition();
      let x = visW / 2 - w / 2;
      let y = visH * 0.12;
      if (ring?.visible) {
        x = ring.x - w / 2;
        y = ring.bandTop - h - (mobile ? 18 : 28);
      }
      x = Math.max(12, Math.min(visW - w - 12, x));
      y = Math.max(12, Math.min(visH - h - 12, y));
      card.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [call]);

  // Call phase drives the band, the ringtone and small sounds.
  const prevPhase = useRef(view.phase);
  useEffect(() => {
    const map: Record<CallView["phase"], BandMode> = { idle: "idle", ringing: "ringing", connecting: "active", active: "active", ended: "ending" };
    filmRef.current?.setMode(map[view.phase]);
    if (view.phase === "ringing") startRingtone();
    else stopRingtone();
    if (view.phase === "active" && prevPhase.current !== "active") playConnect();
    if (view.phase === "ended" && prevPhase.current !== "ended") playHangup();
    if (view.phase === "idle") setBanner(null);
    prevPhase.current = view.phase;
  }, [view.phase]);

  // Server pushes that matter to the call.
  useEffect(
    () =>
      session.subscribe((ev) => {
        if (ev.type === "ring") call.ring(ev.callId);
        else if (ev.type === "call_context") call.context(ev.text);
        else if (ev.type === "call_user_text") call.userText(ev.text);
        else if (ev.type === "call_end") call.serverIdle();
        else if (ev.type === "message" && ev.message.role === "assistant") {
          // Mid-call, a link arrives like a notification on the phone.
          if (call.view.phase === "active" && ev.message.kind === "gmail_card") setBanner(ev.message);
          else if (call.view.phase === "idle") playMessage();
        }
      }),
    [session.subscribe, call],
  );

  // Reconcile with server state (snapshot after reload, or a call that ended elsewhere).
  const firstSnapshot = useRef(true);
  useEffect(() => {
    if (!state) return;
    const cur = state.call.current;
    if (firstSnapshot.current) {
      firstSnapshot.current = false;
      if (state.call.phase === "active" && cur && CallController.staleCallFromThisTab(cur.id)) {
        session.post("call/end", { callId: cur.id, reason: "error", detail: "page reloaded", transcript: [] }).catch(() => {});
        return;
      }
    }
    if (state.call.phase === "ringing" && cur) call.ring(cur.id);
    else if (state.call.phase === "idle") call.serverIdle();
    if (state.started) setStarting(false);
  }, [state, call, session.post]);

  const start = useCallback(async () => {
    unlockAudio();
    setStarting(true);
    try {
      await session.post("start");
    } catch {
      setStarting(false);
    }
  }, [session.post]);

  // Resetting mid-call should not leave audio running.
  const reset = useCallback(async () => {
    await call.hangUp();
    setGmailOpen(false);
    setBanner(null);
    setStarting(false);
    await session.reset();
  }, [call, session.reset]);

  const requestCall = useCallback(() => {
    session.post("call/request").catch(() => {});
  }, [session.post]);

  const connectGmail = useCallback(
    async (email: string) => {
      try {
        await session.post("gmail/connect", { email });
        setGmailOpen(false);
        setBanner(null);
        return null;
      } catch (e: any) {
        return e?.data?.error && e.data.error !== "bad_request" ? String(e.data.error) : "That did not work. Check the address and try again.";
      }
    },
    [session.post],
  );

  const closeGmail = useCallback(() => {
    setGmailOpen(false);
    if (session.state?.profile.gmail.status !== "connected") session.post("gmail/cancel").catch(() => {});
  }, [session.post, session.state]);

  const onCall = view.phase === "active" || view.phase === "connecting";
  const name = state?.profile.agentName ?? null;

  return (
    <>
      {/* One stacking context, so the footage can multiply onto the sky behind it. */}
      <div className="stage" aria-hidden="true">
        <div className="sky">
          <i className="cloud c1" />
          <i className="cloud c2" />
          <i className="cloud c3" />
          <i className="cloud c4" />
          <i className="cloud c5" />
        </div>
        <div ref={stageRef} className="film-host" />
      </div>

      <div className="brand">
        <div className="brand-name">Persona Band</div>
      </div>

      {state && !started && (
        <div className="start">
          <div className="start-card glass">
            <h1>Meet your assistant</h1>
            <p>Persona, your new assistant, will call you on your band to get to know you. The call takes about two minutes, and you can switch to text at any time.</p>
            <button className="btn primary start-btn" onClick={start}>
              Start onboarding
            </button>
            <p className="start-note">The call uses your microphone.</p>
          </div>
        </div>
      )}

      <div className="insights-wrap">
        <Insights state={state} onReset={reset} />
      </div>

      <CallCard
        ref={cardRef}
        view={view}
        name={name}
        onAccept={() => call.accept()}
        onDecline={() => call.decline()}
        onHangUp={() => call.hangUp()}
        onMute={(m) => call.setMuted(m)}
      />

      {/* Tapping the glowing ring answers, like the finger in the film. */}
      <button
        ref={ringHitRef}
        className={`ring-hit ${view.phase === "ringing" ? "armed" : ""}`}
        onClick={() => call.accept()}
        aria-label="Answer on the band"
        tabIndex={view.phase === "ringing" ? 0 : -1}
      />

      {banner && (
        <button
          className="banner glass"
          onClick={() => {
            setGmailOpen(true);
            setBanner(null);
          }}
        >
          <span className="banner-icon">
            <MailIcon size={20} />
          </span>
          <span className="banner-text">
            <span className="banner-title">{name ?? DEFAULT_AGENT_NAME}</span>
            <span className="banner-body">Tap here to connect your Gmail with a secure link.</span>
          </span>
        </button>
      )}

      <div className={`panel ${inCall && !sheetOpen ? "collapsed" : ""}`} ref={panelRef}>
        <Messages
          state={state}
          messages={messages}
          typing={session.typing}
          online={session.online}
          onCall={onCall}
          onSend={session.send}
          onRequestCall={requestCall}
          onOpenGmail={() => setGmailOpen(true)}
          onHeaderTap={() => setSheetOpen((o) => !o)}
        />
      </div>

      <p className="credit">Prototype for Persona. Band footage from yourpersona.com.</p>

      <GmailSheet open={gmailOpen} agentName={name} suggested={state?.profile.gmail.address ?? null} onConnect={connectGmail} onClose={closeGmail} />
    </>
  );
}
