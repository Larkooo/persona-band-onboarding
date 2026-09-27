// Secrets are not in the generated config types.
interface Env {
  ELEVENLABS_API_KEY?: string;
  /** "1" turns calls off entirely. */
  VOICE_DISABLED?: string;
  /** Deepgram Aura-2 speaker for the built-in voice. */
  LOCAL_VOICE?: string;
}
