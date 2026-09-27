// Small synthesized sounds, so there are no audio assets to load.

let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

/** Browsers only allow audio after a gesture; call this from the first tap or key press. */
export function unlockAudio() {
  ac();
}

function bell(a: AudioContext, t: number, freq: number, gain = 0.16, dur = 1.1) {
  const out = a.createGain();
  out.gain.setValueAtTime(0, t);
  out.gain.linearRampToValueAtTime(gain, t + 0.008);
  out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  out.connect(a.destination);
  // A soft bell: fundamental plus a quiet inharmonic partial.
  for (const [mult, g] of [
    [1, 1],
    [2.76, 0.18],
    [5.4, 0.05],
  ] as const) {
    const o = a.createOscillator();
    const og = a.createGain();
    o.type = "sine";
    o.frequency.value = freq * mult;
    og.gain.value = g;
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + dur);
  }
}

let ringTimer: ReturnType<typeof setInterval> | undefined;

/** Two gentle notes, a pause, repeat. Matches the band's double pulse. */
export function startRingtone() {
  stopRingtone();
  const a = ac();
  if (!a) return;
  const once = () => {
    const t = a.currentTime + 0.02;
    bell(a, t, 880);
    bell(a, t + 0.22, 1174.66);
  };
  once();
  ringTimer = setInterval(once, 1800);
  try {
    navigator.vibrate?.([180, 80, 180, 1360]);
  } catch {}
}

export function stopRingtone() {
  clearInterval(ringTimer);
  ringTimer = undefined;
  try {
    navigator.vibrate?.(0);
  } catch {}
}

export function playConnect() {
  const a = ac();
  if (a) bell(a, a.currentTime + 0.01, 1318.5, 0.08, 0.6);
}

export function playHangup() {
  const a = ac();
  if (!a) return;
  bell(a, a.currentTime + 0.01, 659.25, 0.08, 0.5);
  bell(a, a.currentTime + 0.16, 523.25, 0.08, 0.6);
}

export function playMessage() {
  const a = ac();
  if (a) bell(a, a.currentTime + 0.01, 1567.98, 0.035, 0.35);
}
