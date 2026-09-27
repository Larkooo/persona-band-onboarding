/**
 * The Persona Band on a wrist, driven by segments of the product film instead of a 3D render.
 * The film is multiplied over the sky so its white backdrop disappears and the arm floats in the clouds.
 *
 *   0.0 to 3.9s   arm rises and turns the band toward the viewer (intro)
 *   3.9s          band facing, ring off (ready)
 *   ~4.6s         ring lit white (ringing)
 *   4.6 to 7.5s   a finger taps the ring (answer)
 *   7.5 to 12s    arc spinner, then a steady green ring (connected)
 */

export type BandMode = "idle" | "ringing" | "active" | "ending";

export interface BandFilm {
  setMode(mode: BandMode): void;
  setLevels(agent: number, user: number): void;
  getRingScreenPosition(): { x: number; y: number; visible: boolean; radius: number; bandTop: number };
  setSafeArea(area: { right: number; bottom: number }): void;
  dispose(): void;
}

const FRAME = { w: 1920, h: 1080 };
const RING = { x: 943 / 1920, y: 507 / 1080, r: 38 / 1080 };
const BAND_TOP = 392 / 1080;
const T = { ready: 3.9, ringOn: 4.65, green: 12.9 };

export function createBandFilm(host: HTMLElement, opts: { reducedMotion?: boolean } = {}): BandFilm {
  const small = Math.min(window.innerWidth, window.innerHeight) < 700 || (navigator as any).connection?.saveData;
  host.classList.add("film");
  // Two layers with the same geometry: the footage (multiplied onto the sky) and the ring glow (screened on top).
  host.innerHTML = `
    <div class="film-frame">
      <video class="film-video" muted playsinline preload="auto" disablepictureinpicture></video>
      <canvas class="film-snap"></canvas>
    </div>
    <div class="film-glow-layer">
      <div class="film-glow"><i class="glow-halo"></i><i class="glow-core"></i></div>
    </div>`;
  const frame = host.querySelector<HTMLDivElement>(".film-frame")!;
  const glowLayer = host.querySelector<HTMLDivElement>(".film-glow-layer")!;
  const video = host.querySelector<HTMLVideoElement>(".film-video")!;
  const snap = host.querySelector<HTMLCanvasElement>(".film-snap")!;
  const glow = host.querySelector<HTMLDivElement>(".film-glow")!;
  video.src = small ? "/band/hero-720.mp4" : "/band/hero.mp4";

  let mode: BandMode = "idle";
  let target = 0; // time to play toward, then hold
  let safe = { right: 0, bottom: 0 };
  let geom = { left: 0, top: 0, w: 0, h: 0 };
  let raf = 0;
  let disposed = false;
  let levels = { agent: 0, user: 0 };

  // ---------- layout: place the film so the ring sits in the middle of whatever the panels leave visible ----------

  const layout = () => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const areaW = Math.max(200, vw - safe.right);
    const areaH = Math.max(200, vh - safe.bottom);
    const mobile = vw < 820;
    // Film height relative to the visible area; tuned so the ring reads clearly without cropping the hand.
    const h = mobile ? Math.max(areaH * 1.25, 620) : Math.min(Math.max(areaH * 1.2, 760), areaW * 1.05);
    const w = (h * FRAME.w) / FRAME.h;
    const cx = areaW / 2;
    const cy = areaH * (mobile ? 0.62 : 0.6);
    geom = { w, h, left: cx - RING.x * w, top: cy - RING.y * h };
    for (const el of [frame, glowLayer]) {
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      el.style.transform = `translate3d(${geom.left}px, ${geom.top}px, 0)`;
    }
    const r = RING.r * h;
    glow.style.left = `${RING.x * w}px`;
    glow.style.top = `${RING.y * h}px`;
    glow.style.setProperty("--r", `${r}px`);
  };
  window.addEventListener("resize", layout);
  layout();

  // ---------- playback: play toward a timestamp, then hold that frame ----------

  const playTo = (t: number, rate = 1) => {
    target = t;
    if (Math.abs(video.currentTime - t) < 0.04) {
      video.pause();
      return;
    }
    if (video.currentTime > t) {
      // Going back in time: crossfade from a snapshot so the jump is invisible.
      crossfadeTo(t);
      return;
    }
    video.playbackRate = rate;
    video.play().catch(() => {
      video.currentTime = t;
    });
  };

  const crossfadeTo = (t: number) => {
    snap.width = video.videoWidth || FRAME.w;
    snap.height = video.videoHeight || FRAME.h;
    try {
      snap.getContext("2d")!.drawImage(video, 0, 0, snap.width, snap.height);
      snap.style.transition = "none";
      snap.style.opacity = "1";
    } catch {}
    video.pause();
    video.currentTime = t;
    const fade = () => {
      snap.style.transition = "opacity 0.9s ease";
      snap.style.opacity = "0";
    };
    video.addEventListener("seeked", fade, { once: true });
    setTimeout(fade, 400);
  };

  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!video.paused && video.currentTime >= target - 0.02) {
      video.pause();
      if (Math.abs(video.currentTime - target) > 0.06) video.currentTime = target;
    }
    // Voice: the green ring breathes with the assistant, and shimmers cooler when the user talks.
    if (mode === "active") {
      const a = Math.min(1, levels.agent * 1.6);
      const u = Math.min(1, levels.user * 1.4);
      glow.style.setProperty("--a", a.toFixed(3));
      glow.style.setProperty("--u", u.toFixed(3));
    }
  };
  raf = requestAnimationFrame(tick);

  video.addEventListener(
    "loadeddata",
    () => {
      host.classList.add("film-ready");
      if (opts.reducedMotion) {
        video.currentTime = T.ready;
        target = T.ready;
      } else playTo(T.ready, 1);
    },
    { once: true },
  );
  video.load();

  const setMode = (m: BandMode) => {
    if (m === mode) return;
    mode = m;
    host.dataset.mode = m;
    if (m === "ringing") playTo(T.ringOn, 1);
    else if (m === "active") playTo(T.green, opts.reducedMotion ? 4 : 1.35);
    else {
      glow.style.setProperty("--a", "0");
      glow.style.setProperty("--u", "0");
      playTo(T.ready, 1);
    }
    if (m === "ending") setTimeout(() => mode === "ending" && setMode("idle"), 1200);
  };

  return {
    setMode,
    setLevels(agent, user) {
      levels = { agent, user };
    },
    getRingScreenPosition() {
      const x = geom.left + RING.x * geom.w;
      const y = geom.top + RING.y * geom.h;
      return {
        x,
        y,
        radius: RING.r * geom.h,
        bandTop: geom.top + BAND_TOP * geom.h,
        visible: x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight,
      };
    },
    setSafeArea(area) {
      if (area.right === safe.right && area.bottom === safe.bottom) return;
      safe = area;
      layout();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", layout);
      video.pause();
      video.removeAttribute("src");
      video.load();
      host.innerHTML = "";
      host.classList.remove("film", "film-ready");
    },
  };
}
