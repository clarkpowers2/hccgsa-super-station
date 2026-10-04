export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface KeyQuote {
  text: string;
  timestamp: string | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** One "[HH:MM:SS] text" line per segment; falls back to plain text when the model gave no segments. */
export function buildTranscript(text: string, segments?: Segment[]): string {
  const lines = (segments ?? []).filter((s) => s && typeof s.text === "string" && s.text.trim());
  if (lines.length === 0) return text.trim();
  return lines.map((s) => `[${formatTimestamp(s.start)}] ${s.text.trim()}`).join("\n");
}

const TS_PREFIX = /^\[(\d{2}:\d{2}:\d{2})\] ?/;
export const stripTimestamps = (t: string) =>
  t
    .split("\n")
    .map((l) => l.replace(TS_PREFIX, ""))
    .join("\n");

const normalize = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Keep only quotes that really occur in the transcript (ignoring case and punctuation),
 * and take each timestamp from the transcript itself, never from the model. A model
 * must not be able to put invented words in a creator's mouth.
 */
export function verifyQuotes(candidates: string[], transcript: string, max = 3): KeyQuote[] {
  // Normalized text of each non-empty line, joined with single spaces, so a quote's start
  // offset in `whole` maps back to the line (and timestamp) it begins on, even across lines.
  const lines = transcript
    .split("\n")
    .map((raw) => ({ ts: TS_PREFIX.exec(raw)?.[1] ?? null, norm: normalize(raw.replace(TS_PREFIX, "")) }))
    .filter((l) => l.norm);
  const starts: number[] = [];
  let whole = "";
  for (const l of lines) {
    starts.push(whole.length ? whole.length + 1 : 0);
    whole = whole ? `${whole} ${l.norm}` : l.norm;
  }

  const out: KeyQuote[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const text = raw.trim();
    const n = normalize(text);
    if (text.length > 300 || n.length < 12 || seen.has(n)) continue;
    const at = whole.indexOf(n);
    if (at === -1) continue;
    seen.add(n);
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1]! <= at) line++;
    out.push({ text, timestamp: lines[line]?.ts ?? null });
    if (out.length === max) break;
  }
  return out;
}
