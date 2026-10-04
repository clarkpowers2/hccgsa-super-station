import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { processNextTranscript, type PipelineDeps } from "../src/pipeline";
import { MetadataError } from "../src/metadata";
import { TranscribeError } from "../src/transcribe";
import { all, call, makeEnv, one, registerCreator, run } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const SEGMENTS = [
  { start: 0, end: 4, text: "Welcome to the show." },
  { start: 65, end: 70, text: "Failure is the cheapest tuition you will ever pay." },
];
const TRANSCRIPT = "[00:00:00] Welcome to the show.\n[00:01:05] Failure is the cheapest tuition you will ever pay.";
const META = { summary: "A talk about failure.", aiTags: ["failure", "learning"], keyQuotes: [{ text: "Failure is the cheapest tuition you will ever pay.", timestamp: "00:01:05" }] };

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps & { transcribe: ReturnType<typeof vi.fn>; metadata: ReturnType<typeof vi.fn> } {
  return {
    transcribe: vi.fn(async () => ({ text: "x", segments: SEGMENTS })),
    metadata: vi.fn(async () => META),
    ...over,
  } as any;
}

async function world() {
  const t = makeEnv({ ANTHROPIC_API_KEY: "test-anthropic-key" });
  const creator = await registerCreator(t.env, "creator@example.com");
  const ep = await call(t.env, "POST", "/api/creator/episodes", { token: creator.token, body: { title: "Pilot" } });
  return { ...t, creator, episodeId: ep.json.id as string };
}

/** Upload audio through the real API flow so enqueue-on-upload is exercised. */
async function uploadAudio(w: Awaited<ReturnType<typeof world>>, size = 1000) {
  const up = await call(w.env, "POST", `/api/creator/episodes/${w.episodeId}/uploads`, { token: w.creator.token, body: { kind: "audio", contentType: "audio/mpeg", sizeBytes: size } });
  w.objects.set(up.json.key, { size, httpMetadata: { contentType: "audio/mpeg" } });
  const done = await call(w.env, "POST", `/api/creator/episodes/${w.episodeId}/uploads/complete`, { token: w.creator.token, body: { kind: "audio", key: up.json.key } });
  return { key: up.json.key as string, done };
}

const row = (w: Awaited<ReturnType<typeof world>>) => one<any>(w.env, "SELECT * FROM episodes WHERE id = ?", w.episodeId);

describe("queueing", () => {
  it("a new episode has no transcript work; uploading audio queues it", async () => {
    const w = await world();
    expect((await call(w.env, "GET", `/api/creator/episodes/${w.episodeId}`, { token: w.creator.token })).json).toMatchObject({ transcriptStatus: "none", hasTranscript: false });
    const { done } = await uploadAudio(w);
    expect(done.json).toMatchObject({ transcriptStatus: "pending", hasTranscript: false });
  });

  it("video and thumbnail uploads do not queue a transcript", async () => {
    const w = await world();
    for (const [kind, contentType] of [["video", "video/mp4"], ["thumbnail", "image/png"]] as const) {
      const up = await call(w.env, "POST", `/api/creator/episodes/${w.episodeId}/uploads`, { token: w.creator.token, body: { kind, contentType, sizeBytes: 10 } });
      w.objects.set(up.json.key, { size: 10, httpMetadata: { contentType } });
      await call(w.env, "POST", `/api/creator/episodes/${w.episodeId}/uploads/complete`, { token: w.creator.token, body: { kind, key: up.json.key } });
    }
    expect((await row(w)).transcript_status).toBe("none");
  });

  it("replacing the audio discards the old transcript and summary", async () => {
    const w = await world();
    await uploadAudio(w);
    await processNextTranscript(w.env, deps());
    expect((await row(w)).summary).toBe(META.summary);
    await uploadAudio(w);
    expect(await row(w)).toMatchObject({ transcript_status: "pending", transcript_text: null, summary: null, ai_tags: null, key_quotes: null, transcript_attempts: 0 });
  });

  it("reports idle when nothing is queued", async () => {
    const w = await world();
    expect(await processNextTranscript(w.env, deps())).toEqual({ outcome: "idle" });
  });
});

describe("pipeline", () => {
  it("transcribes with timestamps, generates metadata, and completes", async () => {
    const w = await world();
    await uploadAudio(w);
    const d = deps();
    expect(await processNextTranscript(w.env, d)).toEqual({ episodeId: w.episodeId, outcome: "completed" });
    expect(d.metadata).toHaveBeenCalledWith(w.env, { title: "Pilot", transcript: TRANSCRIPT });
    expect(await row(w)).toMatchObject({
      transcript_status: "completed",
      transcript_text: TRANSCRIPT,
      summary: META.summary,
      transcript_error: null,
      transcript_attempts: 1,
    });
    expect(JSON.parse((await row(w)).key_quotes)).toEqual(META.keyQuotes);
    expect(await one<any>(w.env, "SELECT transcript_finished_at f FROM episodes")).not.toEqual({ f: null });
  });

  it("rejects audio over the size cap without calling any AI service", async () => {
    const w = await world();
    await uploadAudio(w, 30 * 1024 * 1024);
    const d = deps();
    expect(await processNextTranscript(w.env, d)).toMatchObject({ outcome: "failed" });
    expect(d.transcribe).not.toHaveBeenCalled();
    expect((await row(w)).transcript_error).toMatch(/30 MB.*up to 24 MB/);
  });

  it("fails permanently when the audio file is missing from storage", async () => {
    const w = await world();
    const { key } = await uploadAudio(w);
    w.objects.delete(key);
    expect(await processNextTranscript(w.env, deps())).toMatchObject({ outcome: "failed" });
    expect((await row(w)).transcript_error).toMatch(/could not be found/);
  });

  it("fails permanently on 'no speech' and never leaks internals on unexpected errors", async () => {
    const w = await world();
    await uploadAudio(w);
    const quiet = deps({ transcribe: vi.fn(async () => { throw new TranscribeError("No speech was detected in the audio", false); }) });
    expect(await processNextTranscript(w.env, quiet)).toMatchObject({ outcome: "failed" });
    expect((await row(w)).transcript_error).toBe("No speech was detected in the audio");

    await uploadAudio(w); // re-queue
    const boom = deps({ transcribe: vi.fn(async () => { throw new Error("db password=hunter2 at /srv/internal"); }) });
    await processNextTranscript(w.env, boom);
    expect((await row(w)).transcript_error).toBe("Transcription failed unexpectedly");
  });

  it("retries transient failures up to 3 attempts, then fails", async () => {
    const w = await world();
    await uploadAudio(w);
    const flaky = deps({ transcribe: vi.fn(async () => { throw new TranscribeError("Speech-to-text service error", true); }) });
    expect((await processNextTranscript(w.env, flaky)).outcome).toBe("retry");
    expect(await row(w)).toMatchObject({ transcript_status: "pending", transcript_attempts: 1 });
    expect((await processNextTranscript(w.env, flaky)).outcome).toBe("retry");
    expect((await processNextTranscript(w.env, flaky)).outcome).toBe("failed");
    expect(await row(w)).toMatchObject({ transcript_status: "failed", transcript_attempts: 3 });
    expect((await processNextTranscript(w.env, flaky)).outcome).toBe("idle");
  });

  it("checkpoints the transcript so a summary retry does not pay for speech-to-text again", async () => {
    const w = await world();
    await uploadAudio(w);
    const d = deps({ metadata: vi.fn().mockRejectedValueOnce(new MetadataError("The summary service is busy", true)).mockResolvedValue(META) });
    expect((await processNextTranscript(w.env, d)).outcome).toBe("retry");
    expect((await row(w)).transcript_text).toBe(TRANSCRIPT);
    expect((await processNextTranscript(w.env, d)).outcome).toBe("completed");
    expect(d.transcribe).toHaveBeenCalledTimes(1);
    expect(d.metadata).toHaveBeenCalledTimes(2);
  });

  it("still delivers the transcript when the summary permanently fails", async () => {
    const w = await world();
    await uploadAudio(w);
    const d = deps({ metadata: vi.fn(async () => { throw new MetadataError("The summary service declined this content", false); }) });
    expect((await processNextTranscript(w.env, d)).outcome).toBe("completed");
    expect(await row(w)).toMatchObject({ transcript_status: "completed", summary: null, transcript_error: "The summary service declined this content" });
    expect((await call(w.env, "GET", `/api/creator/episodes/${w.episodeId}/transcript`, { token: w.creator.token })).json.transcript).toBe(TRANSCRIPT);
  });

  it("gives up on summaries after the last attempt instead of looping forever", async () => {
    const w = await world();
    await uploadAudio(w);
    await run(w.env, "UPDATE episodes SET transcript_attempts = 2 WHERE id = ?", w.episodeId);
    const d = deps({ metadata: vi.fn(async () => { throw new MetadataError("The summary service is busy", true); }) });
    expect((await processNextTranscript(w.env, d)).outcome).toBe("completed");
    expect((await row(w)).transcript_error).toBe("The summary service is busy");
  });

  it("discards a result for audio that was replaced while it was being processed", async () => {
    const w = await world();
    await uploadAudio(w);
    const d = deps({
      transcribe: vi.fn(async () => {
        // creator swaps the audio mid-run
        await run(w.env, "UPDATE episodes SET audio_key = 'new/audio.mp3', transcript_status = 'pending', transcript_text = NULL WHERE id = ?", w.episodeId);
        return { text: "x", segments: SEGMENTS };
      }),
    });
    expect((await processNextTranscript(w.env, d)).outcome).toBe("discarded");
    expect(await row(w)).toMatchObject({ transcript_status: "pending", transcript_text: null, summary: null, audio_key: "new/audio.mp3" });
  });

  it("recovers jobs stuck in 'processing': requeues them, or fails them after the last attempt", async () => {
    const w = await world();
    await uploadAudio(w);
    await run(w.env, "UPDATE episodes SET transcript_status = 'processing', transcript_attempts = 1, transcript_started_at = datetime('now', '-1 hour') WHERE id = ?", w.episodeId);
    expect((await processNextTranscript(w.env, deps())).outcome).toBe("completed");

    await uploadAudio(w);
    await run(w.env, "UPDATE episodes SET transcript_status = 'processing', transcript_attempts = 3, transcript_started_at = datetime('now', '-1 hour') WHERE id = ?", w.episodeId);
    expect((await processNextTranscript(w.env, deps())).outcome).toBe("idle");
    expect(await row(w)).toMatchObject({ transcript_status: "failed", transcript_error: "Transcription timed out" });
  });

  it("does not touch a job that is still within the processing window", async () => {
    const w = await world();
    await uploadAudio(w);
    await run(w.env, "UPDATE episodes SET transcript_status = 'processing', transcript_attempts = 1, transcript_started_at = datetime('now') WHERE id = ?", w.episodeId);
    expect((await processNextTranscript(w.env, deps())).outcome).toBe("idle");
  });
});

describe("creator re-run", () => {
  const rerun = (w: Awaited<ReturnType<typeof world>>, token = w.creator.token) =>
    call(w.env, "POST", `/api/creator/episodes/${w.episodeId}/transcribe`, { token });

  it("requires audio, an idle job, and respects a one-hour cooldown", async () => {
    const w = await world();
    expect((await rerun(w)).status).toBe(409); // no audio yet
    await uploadAudio(w);
    expect((await rerun(w)).status).toBe(409); // already pending
    await processNextTranscript(w.env, deps());
    const cooling = await rerun(w);
    expect(cooling.status).toBe(429);
    expect(cooling.json.retryAfterMinutes).toBeGreaterThan(55);
    await run(w.env, "UPDATE episodes SET transcript_finished_at = datetime('now', '-2 hours') WHERE id = ?", w.episodeId);
    const ok = await rerun(w);
    expect(ok.status).toBe(202);
    expect(ok.json).toMatchObject({ transcriptStatus: "pending", summary: null });
  });

  it("lets a failed job be retried after the cooldown and hides other creators' episodes", async () => {
    const w = await world();
    await uploadAudio(w);
    await run(w.env, "UPDATE episodes SET transcript_status = 'failed', transcript_finished_at = datetime('now', '-3 hours') WHERE id = ?", w.episodeId);
    const other = await registerCreator(w.env, "other@example.com");
    expect((await rerun(w, other.token)).status).toBe(404);
    expect((await rerun(w)).status).toBe(202);
  });
});

describe("what viewers can see", () => {
  async function published() {
    const w = await world();
    await uploadAudio(w);
    await processNextTranscript(w.env, deps());
    await run(w.env, "UPDATE episodes SET is_published = 1, publish_date = datetime('now') WHERE id = ?", w.episodeId);
    const viewer = await call(w.env, "POST", "/api/auth/register", { body: { email: "viewer@example.com", password: "a-long-test-password", creatorName: "V" } });
    return { ...w, viewer: { token: viewer.json.token as string, id: viewer.json.id as string } };
  }
  const getTranscript = (w: Awaited<ReturnType<typeof published>>, token?: string) => call(w.env, "GET", `/api/episodes/${w.episodeId}/transcript`, { token });

  it("shows summary, tags and quotes publicly, but never the transcript text", async () => {
    const w = await published();
    const r = await call(w.env, "GET", `/api/episodes/${w.episodeId}`);
    expect(r.json).toMatchObject({ summary: META.summary, aiTags: META.aiTags, keyQuotes: META.keyQuotes, hasTranscript: true });
    expect(JSON.stringify(r.json)).not.toContain("Welcome to the show");
    const list = await call(w.env, "GET", "/api/episodes");
    expect(list.json.episodes[0].summary).toBe(META.summary);
    expect(JSON.stringify(list.json)).not.toContain("Welcome to the show");
  });

  it("gates the full transcript behind login and a purchase, subscription, or ownership", async () => {
    const w = await published();
    expect((await getTranscript(w)).status).toBe(401);
    expect((await getTranscript(w, w.viewer.token)).status).toBe(403);
    expect((await getTranscript(w, w.creator.token)).json.transcript).toBe(TRANSCRIPT);

    await run(w.env, "INSERT INTO purchases (id, viewer_id, episode_id, stripe_payment_intent_id, amount_cents, status) VALUES ('p1', ?, ?, 'pi_x', 499, 'completed')", w.viewer.id, w.episodeId);
    expect((await getTranscript(w, w.viewer.token)).json.transcript).toBe(TRANSCRIPT);
    await run(w.env, "DELETE FROM purchases");
    expect((await getTranscript(w, w.viewer.token)).status).toBe(403);

    await run(w.env, "INSERT INTO subscriptions (id, viewer_id, creator_id, stripe_subscription_id, status, price_per_month_cents, started_at) VALUES ('s1', ?, ?, 'sub_x', 'active', 500, datetime('now'))", w.viewer.id, w.creator.id);
    expect((await getTranscript(w, w.viewer.token)).status).toBe(200);
    await run(w.env, "UPDATE subscriptions SET status = 'canceled'");
    expect((await getTranscript(w, w.viewer.token)).status).toBe(403);
  });

  it("hides unpublished transcripts from non-owners and 404s when there is none", async () => {
    const w = await published();
    await run(w.env, "UPDATE episodes SET is_published = 0 WHERE id = ?", w.episodeId);
    expect((await getTranscript(w, w.viewer.token)).status).toBe(404);
    await run(w.env, "UPDATE episodes SET is_published = 1, transcript_text = NULL WHERE id = ?", w.episodeId);
    await run(w.env, "INSERT INTO purchases (id, viewer_id, episode_id, stripe_payment_intent_id, amount_cents, status) VALUES ('p1', ?, ?, 'pi_y', 499, 'completed')", w.viewer.id, w.episodeId);
    expect((await getTranscript(w, w.viewer.token)).status).toBe(404);
    expect((await call(w.env, "GET", `/api/episodes/${w.episodeId}`)).json.hasTranscript).toBe(false);
  });
});

describe("scheduled worker, end to end through the real adapters", () => {
  it("transcribes with Workers AI, summarizes with Claude, and stores the result", async () => {
    const w = await world();
    await uploadAudio(w);
    const aiRun = vi.fn(async () => ({ text: "x", segments: SEGMENTS }));
    const env = { ...w.env, AI: { run: aiRun } as any };
    const anthropicBody = {
      summary: "A talk about failure.",
      tags: ["failure", "learning", "money", "growth", "mindset"],
      key_quotes: ["Failure is the cheapest tuition you will ever pay.", "Something never said."],
    };
    const fetchStub = vi.fn(async () =>
      new Response(
        JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify(anthropicBody) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchStub);

    const pending: Promise<unknown>[] = [];
    await worker.scheduled({} as any, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as any);
    await Promise.all(pending);

    expect(aiRun).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(await row(w)).toMatchObject({ transcript_status: "completed", transcript_text: TRANSCRIPT, summary: "A talk about failure." });
    expect(JSON.parse((await row(w)).ai_tags)).toEqual(["failure", "learning", "money", "growth", "mindset"]);
    expect(JSON.parse((await row(w)).key_quotes)).toEqual([{ text: "Failure is the cheapest tuition you will ever pay.", timestamp: "00:01:05" }]);
    expect(await all(w.env, "SELECT * FROM episodes WHERE transcript_status = 'pending'")).toHaveLength(0);
  });

  it("a failing tick never throws out of the scheduled handler", async () => {
    const w = await world();
    await uploadAudio(w);
    const env = { ...w.env, AI: { run: async () => { throw new Error("boom"); } } as any };
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({} as any, env, { waitUntil: (p: Promise<unknown>) => pending.push(p) } as any);
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect((await row(w)).transcript_status).toBe("pending"); // queued for retry
  });
});
