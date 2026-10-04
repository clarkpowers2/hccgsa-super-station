import type { Env } from "./types";
import { DEFAULT_MAX_AUDIO_BYTES, TranscribeError, transcribeAudio } from "./transcribe";
import { MetadataError, generateMetadata, type EpisodeMetadata } from "./metadata";
import { buildTranscript, type Segment } from "./transcript";

export const MAX_ATTEMPTS = 3;
const STUCK_MINUTES = 20;

export interface PipelineDeps {
  transcribe(env: Env, audio: ArrayBuffer): Promise<{ text: string; segments: Segment[] }>;
  metadata(env: Env, input: { title: string; transcript: string }): Promise<EpisodeMetadata>;
}

const realDeps: PipelineDeps = { transcribe: transcribeAudio, metadata: (env, input) => generateMetadata(env, input) };

class PermanentError extends Error {}

/** Put an episode's audio into the transcription queue, discarding any earlier results. */
export async function enqueueTranscript(env: Env, episodeId: string) {
  await env.DB.prepare(
    `UPDATE episodes SET transcript_status = 'pending', transcript_text = NULL, summary = NULL, ai_tags = NULL, key_quotes = NULL,
       transcript_error = NULL, transcript_attempts = 0, transcript_started_at = NULL, transcript_finished_at = NULL,
       updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(episodeId)
    .run();
}

async function reclaimStuck(env: Env) {
  const stale = `transcript_status = 'processing' AND transcript_started_at < datetime('now', '-${STUCK_MINUTES} minutes')`;
  await env.DB.prepare(`UPDATE episodes SET transcript_status = 'pending' WHERE ${stale} AND transcript_attempts < ?`).bind(MAX_ATTEMPTS).run();
  await env.DB.prepare(
    `UPDATE episodes SET transcript_status = 'failed', transcript_error = 'Transcription timed out', transcript_finished_at = datetime('now')
     WHERE ${stale} AND transcript_attempts >= ?`,
  )
    .bind(MAX_ATTEMPTS)
    .run();
}

interface Claimed {
  id: string;
  title: string;
  audio_key: string | null;
  transcript_text: string | null;
  transcript_attempts: number;
}

export type TickOutcome = "idle" | "completed" | "retry" | "failed" | "discarded";

/**
 * Process at most one queued episode. Progress is checkpointed: if speech-to-text
 * succeeded but the summary step failed, the retry skips straight to the summary.
 * Writes are guarded by the audio key we started with, so a result for audio that was
 * replaced mid-run is thrown away instead of overwriting the new episode state.
 */
export async function processNextTranscript(env: Env, deps: PipelineDeps = realDeps): Promise<{ episodeId?: string; outcome: TickOutcome }> {
  await reclaimStuck(env);

  const row = await env.DB.prepare(
    `UPDATE episodes SET transcript_status = 'processing', transcript_started_at = datetime('now'),
       transcript_attempts = transcript_attempts + 1
     WHERE id = (SELECT id FROM episodes WHERE transcript_status = 'pending' ORDER BY updated_at, id LIMIT 1)
       AND transcript_status = 'pending'
     RETURNING id, title, audio_key, transcript_text, transcript_attempts`,
  ).first<Claimed>();
  if (!row) return { outcome: "idle" };

  const guard = "WHERE id = ? AND transcript_status = 'processing' AND audio_key IS ?";
  const key = row.audio_key;
  const fail = async (message: string): Promise<TickOutcome> => {
    await env.DB.prepare(
      `UPDATE episodes SET transcript_status = 'failed', transcript_error = ?, transcript_finished_at = datetime('now') ${guard}`,
    )
      .bind(message, row.id, key)
      .run();
    return "failed";
  };

  try {
    if (!key) throw new PermanentError("This episode has no audio file to transcribe");
    let transcript = row.transcript_text;

    if (!transcript) {
      const head = await env.MEDIA.head(key);
      if (!head) throw new PermanentError("The audio file could not be found");
      const max = Number(env.TRANSCRIBE_MAX_BYTES) || DEFAULT_MAX_AUDIO_BYTES;
      if (head.size > max) {
        const mb = (n: number) => Math.round(n / 1024 / 1024);
        throw new PermanentError(`This audio file is ${mb(head.size)} MB; automatic transcription currently supports files up to ${mb(max)} MB`);
      }
      const obj = await env.MEDIA.get(key);
      if (!obj) throw new PermanentError("The audio file could not be found");
      const { text, segments } = await deps.transcribe(env, await obj.arrayBuffer());
      transcript = buildTranscript(text, segments);
      await env.DB.prepare(`UPDATE episodes SET transcript_text = ? ${guard}`).bind(transcript, row.id, key).run(); // checkpoint
    }

    let meta: EpisodeMetadata | null = null;
    let metaError: string | null = null;
    try {
      meta = await deps.metadata(env, { title: row.title, transcript });
    } catch (e) {
      if (e instanceof MetadataError && (!e.retryable || row.transcript_attempts >= MAX_ATTEMPTS)) metaError = e.message;
      else throw e;
    }

    await env.DB.prepare(
      `UPDATE episodes SET transcript_status = 'completed', summary = ?, ai_tags = ?, key_quotes = ?, transcript_error = ?,
         transcript_finished_at = datetime('now') ${guard}`,
    )
      .bind(
        meta?.summary ?? null,
        meta ? JSON.stringify(meta.aiTags) : null,
        meta ? JSON.stringify(meta.keyQuotes) : null,
        metaError,
        row.id,
        key,
      )
      .run();

    const still = await env.DB.prepare("SELECT transcript_status AS s FROM episodes WHERE id = ?").bind(row.id).first<{ s: string }>();
    return { episodeId: row.id, outcome: still?.s === "completed" ? "completed" : "discarded" };
  } catch (e) {
    const permanent = e instanceof PermanentError || (e instanceof TranscribeError && !e.retryable) || (e instanceof MetadataError && !e.retryable);
    const known = e instanceof PermanentError || e instanceof TranscribeError || e instanceof MetadataError;
    console.error("transcript pipeline error", row.id, e instanceof Error ? e.constructor.name : "unknown");
    const message = known ? (e as Error).message : "Transcription failed unexpectedly";

    if (permanent || row.transcript_attempts >= MAX_ATTEMPTS) return { episodeId: row.id, outcome: await fail(message) };
    await env.DB.prepare(`UPDATE episodes SET transcript_status = 'pending', transcript_error = ? ${guard}`).bind(message, row.id, key).run();
    return { episodeId: row.id, outcome: "retry" };
  }
}
