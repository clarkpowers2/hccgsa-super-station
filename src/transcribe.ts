import type { Env } from "./types";
import type { Segment } from "./transcript";

// Cloudflare Workers AI speech-to-text. Claude does not accept audio input.
// NOTE: input/output shape and size limits are from memory of the Workers AI docs
// (which could not be fetched when this was written). Verify in `wrangler dev` first.
export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const DEFAULT_MAX_AUDIO_BYTES = 24 * 1024 * 1024;

export class TranscribeError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
  }
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export async function transcribeAudio(env: Env, audio: ArrayBuffer): Promise<{ text: string; segments: Segment[] }> {
  let out: any;
  try {
    out = await (env.AI as unknown as { run(model: string, input: object): Promise<any> }).run(WHISPER_MODEL, {
      audio: toBase64(audio),
      task: "transcribe",
      vad_filter: true,
    });
  } catch {
    throw new TranscribeError("Speech-to-text service error", true);
  }
  const text = typeof out?.text === "string" ? out.text.trim() : "";
  if (!text) throw new TranscribeError("No speech was detected in the audio", false);
  const segments: Segment[] = Array.isArray(out.segments)
    ? out.segments
        .filter((s: any) => s && typeof s.text === "string")
        .map((s: any) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: s.text }))
    : [];
  return { text, segments };
}
