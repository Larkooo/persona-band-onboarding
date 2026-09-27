import { useEffect, useRef, useState } from "react";
import { DEFAULT_AGENT_NAME } from "../../shared/types";
import { LockIcon, MailIcon } from "./icons";

interface Props {
  open: boolean;
  agentName: string | null;
  suggested: string | null;
  onConnect(email: string): Promise<string | null>; // resolves to an error message, or null on success
  onClose(): void;
}

/** A simulated OAuth consent step. It records the address; no real Google account is touched. */
export function GmailSheet({ open, agentName, suggested, onConnect, onClose }: Props) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setEmail(suggested ?? "");
      setError(null);
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open, suggested]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const who = agentName ?? DEFAULT_AGENT_NAME;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form
        className="sheet glass"
        role="dialog"
        aria-label="Connect Gmail"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          const err = await onConnect(email);
          setBusy(false);
          if (err) setError(err);
        }}
      >
        <div className="sheet-icon">
          <MailIcon size={26} />
        </div>
        <h2>Connect Gmail</h2>
        <p className="sheet-body">
          {who} will be able to read your email and prepare drafts for you. Nothing is sent without your approval.
        </p>
        <label className="field">
          <span>Google account</span>
          <input
            ref={inputRef}
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@gmail.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setError(null);
            }}
          />
        </label>
        {error && <p className="field-error">{error}</p>}
        <div className="sheet-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !email.trim()}>
            {busy ? "Connecting" : "Connect"}
          </button>
        </div>
        <p className="sheet-note">
          <LockIcon size={12} /> This prototype simulates the connection. No real account is accessed.
        </p>
      </form>
    </div>
  );
}
