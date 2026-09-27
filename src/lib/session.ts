import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage, ClientEvent, ServerEvent, SessionState } from "../../shared/types";

const KEY = "onboarding-session";

function newId() {
  return crypto.randomUUID().replace(/-/g, "");
}

function loadId(): string {
  try {
    const v = localStorage.getItem(KEY);
    if (v && /^[a-f0-9]{32}$/.test(v)) return v;
    const id = newId();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return newId();
  }
}

export async function api<T = any>(id: string, action: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/s/${id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data as T;
}

export type Listener = (ev: ServerEvent) => void;

export interface Session {
  id: string;
  state: SessionState | null;
  messages: ChatMessage[];
  typing: boolean;
  online: boolean;
  send(text: string): Promise<void>;
  post<T = any>(action: string, body?: unknown): Promise<T>;
  wsSend(ev: ClientEvent): void;
  subscribe(fn: Listener): () => void;
  reset(): Promise<void>;
}

/** Owns the session id, the initial snapshot and a self-healing WebSocket for pushed updates. */
export function useSession(): Session {
  const [id, setId] = useState(loadId);
  const [state, setState] = useState<SessionState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typing, setTyping] = useState(false);
  const [online, setOnline] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const listeners = useRef(new Set<Listener>());

  const onEvent = useCallback((ev: ServerEvent) => {
    switch (ev.type) {
      case "snapshot":
        setState(ev.state);
        setMessages(ev.messages);
        break;
      case "state":
        setState(ev.state);
        break;
      case "message":
        setMessages((m) => (m.some((x) => x.id === ev.message.id) ? m : [...m, ev.message]));
        if (ev.message.role === "assistant") setTyping(false);
        break;
      case "typing":
        setTyping(ev.on);
        break;
    }
    for (const fn of listeners.current) fn(ev);
  }, []);

  useEffect(() => {
    let alive = true;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ping: ReturnType<typeof setInterval> | undefined;

    const connect = async () => {
      if (!alive) return;
      try {
        const snap = await api(id, "init");
        if (!alive) return;
        onEvent({ type: "snapshot", state: snap.state, messages: snap.messages });
      } catch {
        setOnline(false);
        timer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
        return;
      }
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/s/${id}/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setOnline(true);
        ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: "ping" })), 25000);
      };
      ws.onmessage = (e) => {
        try {
          onEvent(JSON.parse(e.data));
        } catch {}
      };
      ws.onclose = (e) => {
        clearInterval(ping);
        if (!alive || e.code === 4000) return;
        setOnline(false);
        timer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
      };
    };
    connect();

    const onVisible = () => {
      if (document.visibilityState === "visible" && wsRef.current?.readyState !== 1) {
        clearTimeout(timer);
        retry = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(ping);
      document.removeEventListener("visibilitychange", onVisible);
      wsRef.current?.close();
    };
  }, [id, onEvent]);

  const send = useCallback(
    async (text: string) => {
      // Optimistic bubble; the server echo has a different id, so replace it on arrival.
      const temp: ChatMessage = { id: `local-${Date.now()}`, role: "user", kind: "text", text, ts: Date.now() };
      setMessages((m) => [...m, temp]);
      const unsub = (() => {
        const fn: Listener = (ev) => {
          if (ev.type === "message" && ev.message.role === "user" && ev.message.text === text.replace(/\s+$/g, "")) {
            setMessages((m) => m.filter((x) => x.id !== temp.id));
            listeners.current.delete(fn);
          }
        };
        listeners.current.add(fn);
        return () => listeners.current.delete(fn);
      })();
      try {
        await api(id, "message", { text });
      } catch (e: any) {
        unsub();
        setMessages((m) => m.map((x) => (x.id === temp.id ? { ...x, meta: { failed: e?.status === 429 ? "rate" : "error" } } : x)));
      }
    },
    [id],
  );

  const post = useCallback(<T,>(action: string, body?: unknown) => api<T>(id, action, body), [id]);

  const wsSend = useCallback((ev: ClientEvent) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(ev));
  }, []);

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const reset = useCallback(async () => {
    const next = newId();
    try {
      localStorage.setItem(KEY, next);
    } catch {}
    setState(null);
    setMessages([]);
    setTyping(false);
    setId(next);
  }, []);

  return { id, state, messages, typing, online, send, post, wsSend, subscribe, reset };
}
