import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, MetadataError, generateMetadata, sanitizeMetadata } from "../src/metadata";
import { DEFAULT_MAX_AUDIO_BYTES, TranscribeError, WHISPER_MODEL, transcribeAudio } from "../src/transcribe";
import { makeEnv } from "./helpers";

const TRANSCRIPT = "[00:00:05] Welcome to the show.\n[00:01:00] Failure is the cheapest tuition you will ever pay.";

function message(content: string, extra: object = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: DEFAULT_MODEL,
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
    ...extra,
  };
}

function fakeAnthropic(status: number, body: unknown) {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const good = JSON.stringify({
  summary: "  A talk about failure and money.  ",
  tags: ["Failure", "money", "money", "  ", "x".repeat(40), "Learning", "Business", "Mindset", "extra1", "extra2", "extra3"],
  key_quotes: ["Failure is the cheapest tuition you will ever pay.", "A line the speaker never said at all."],
});

describe("generateMetadata (Claude)", () => {
  it("sends the right request, treats the transcript as data, and sanitizes the answer", async () => {
    const { env } = makeEnv({ ANTHROPIC_API_KEY: "test-anthropic-key" });
    const { calls, fetchImpl } = fakeAnthropic(200, message(good));
    const meta = await generateMetadata(env, { title: "Pilot", transcript: TRANSCRIPT }, { fetch: fetchImpl, maxRetries: 0 });

    const call = calls[0]!;
    expect(new URL(call.url).pathname).toBe("/v1/messages");
    expect(call.headers.get("x-api-key")).toBe("test-anthropic-key");
    expect(call.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(call.body).toMatchObject({ model: DEFAULT_MODEL, fallbacks: "default", output_config: { effort: "low" } });
    expect(call.body.output_config.format.type).toBe("json_schema");
    expect(call.body.thinking).toBeUndefined();
    expect(call.body.tool_choice).toBeUndefined(); // forced tool use is rejected by this model
    expect(call.body.system).toMatch(/untrusted/i);
    const user = call.body.messages[0].content as string;
    expect(user).toContain("<transcript>");
    expect(user).toContain("Failure is the cheapest tuition");

    expect(meta.summary).toBe("A talk about failure and money.");
    expect(meta.aiTags).toEqual(["failure", "money", "learning", "business", "mindset", "extra1", "extra2", "extra3"]); // deduped, <=30 chars, max 8
    expect(meta.keyQuotes).toEqual([{ text: "Failure is the cheapest tuition you will ever pay.", timestamp: "00:01:00" }]); // invented quote dropped
  });

  it("honours the configured model", async () => {
    const { env } = makeEnv({ ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-sonnet-5-5" });
    const { calls, fetchImpl } = fakeAnthropic(200, message(good));
    await generateMetadata(env, { title: "t", transcript: TRANSCRIPT }, { fetch: fetchImpl, maxRetries: 0 });
    expect(calls[0]!.body.model).toBe("claude-sonnet-5-5");
  });

  it("treats a refusal as permanent", async () => {
    const { env } = makeEnv({ ANTHROPIC_API_KEY: "k" });
    const { fetchImpl } = fakeAnthropic(200, message("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "bio", explanation: null } }));
    await expect(generateMetadata(env, { title: "t", transcript: TRANSCRIPT }, { fetch: fetchImpl, maxRetries: 0 })).rejects.toMatchObject({ retryable: false });
  });

  it("treats unreadable output as retryable", async () => {
    const { env } = makeEnv({ ANTHROPIC_API_KEY: "k" });
    const { fetchImpl } = fakeAnthropic(200, message("not json at all"));
    await expect(generateMetadata(env, { title: "t", transcript: TRANSCRIPT }, { fetch: fetchImpl, maxRetries: 0 })).rejects.toBeInstanceOf(MetadataError);
  });

  it.each([
    [500, true],
    [429, true],
    [401, false],
    [400, false],
  ])("maps HTTP %i to retryable=%s without leaking details", async (status, retryable) => {
    const { env } = makeEnv({ ANTHROPIC_API_KEY: "k" });
    const { fetchImpl } = fakeAnthropic(status, { type: "error", error: { type: "api_error", message: "secret provider detail" } });
    const err = await generateMetadata(env, { title: "t", transcript: TRANSCRIPT }, { fetch: fetchImpl, maxRetries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(MetadataError);
    expect(err.retryable).toBe(retryable);
    expect(err.message).not.toContain("secret provider detail");
  });

  it("refuses oversized transcripts instead of truncating them", async () => {
    const { env } = makeEnv({ ANTHROPIC_API_KEY: "k" });
    const { calls, fetchImpl } = fakeAnthropic(200, message(good));
    await expect(generateMetadata(env, { title: "t", transcript: "a".repeat(400_001) }, { fetch: fetchImpl })).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(0);
  });
});

describe("sanitizeMetadata", () => {
  it("caps summary length", () => {
    expect(sanitizeMetadata({ summary: "s".repeat(2000), tags: [], key_quotes: [] }, TRANSCRIPT).summary).toHaveLength(800);
  });
});

describe("transcribeAudio (Workers AI)", () => {
  const withAi = (run: (m: string, i: any) => Promise<any>) => ({ ...makeEnv().env, AI: { run } as any });

  it("sends base64 audio to Whisper and returns text with segments", async () => {
    const run = vi.fn(async () => ({ text: " Hello there. ", segments: [{ start: 0, end: 2, text: "Hello there." }, { text: 5 }] }));
    const out = await transcribeAudio(withAi(run), new Uint8Array([1, 2, 3, 4]).buffer);
    expect(run).toHaveBeenCalledWith(WHISPER_MODEL, expect.objectContaining({ audio: "AQIDBA==", task: "transcribe" }));
    expect(out).toEqual({ text: "Hello there.", segments: [{ start: 0, end: 2, text: "Hello there." }] });
  });
  it("treats empty speech as permanent and service errors as retryable", async () => {
    const empty = await transcribeAudio(withAi(async () => ({ text: "  " })), new ArrayBuffer(4)).catch((e) => e);
    expect(empty).toBeInstanceOf(TranscribeError);
    expect(empty.retryable).toBe(false);
    const down = await transcribeAudio(withAi(async () => { throw new Error("internal detail"); }), new ArrayBuffer(4)).catch((e) => e);
    expect(down.retryable).toBe(true);
    expect(down.message).not.toContain("internal detail");
  });
  it("encodes large audio without overflowing the call stack", async () => {
    const run = vi.fn(async () => ({ text: "ok" }));
    await transcribeAudio(withAi(run), new ArrayBuffer(3 * 1024 * 1024));
    expect((run.mock.calls[0] as any)[1].audio.length).toBe(Math.ceil((3 * 1024 * 1024) / 3) * 4);
  });
  it("documents a default size cap", () => expect(DEFAULT_MAX_AUDIO_BYTES).toBe(24 * 1024 * 1024));
});
