import { afterEach, describe, expect, it, vi } from "vitest";

const { transcriptTick, webhookTick } = vi.hoisted(() => ({ transcriptTick: vi.fn(), webhookTick: vi.fn() }));
vi.mock("../src/pipeline", async (orig) => ({ ...(await orig<typeof import("../src/pipeline")>()), processNextTranscript: transcriptTick }));
vi.mock("../src/webhook-sender", async (orig) => ({ ...(await orig<typeof import("../src/webhook-sender")>()), deliverDueWebhooks: webhookTick }));

import worker from "../src/index";

const fakeEnv = { ENVIRONMENT: "test" } as any;

/** Collects what the handler hands to waitUntil, and settles it the way the runtime would. */
function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as any, settle: () => Promise.allSettled(pending) };
}
const run = async () => {
  const { ctx, settle } = fakeCtx();
  await worker.scheduled({} as any, fakeEnv, ctx);
  const results = await settle();
  return results;
};

afterEach(() => {
  vi.restoreAllMocks();
  transcriptTick.mockReset();
  webhookTick.mockReset();
});

describe("scheduled handler", () => {
  it("runs both the transcript tick and the webhook tick with the env", async () => {
    transcriptTick.mockResolvedValue({ outcome: "idle" });
    webhookTick.mockResolvedValue(0);
    const results = await run();
    expect(transcriptTick).toHaveBeenCalledTimes(1);
    expect(transcriptTick.mock.calls[0]![0]).toBe(fakeEnv);
    expect(webhookTick).toHaveBeenCalledTimes(1);
    expect(webhookTick.mock.calls[0]![0]).toBe(fakeEnv);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  });

  it("still runs the webhook tick when the transcript tick fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    transcriptTick.mockRejectedValue(new TypeError("boom with detail"));
    webhookTick.mockResolvedValue(3);
    const results = await run();
    expect(webhookTick).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // Only the error class name is logged, never the message.
    expect(JSON.stringify(err.mock.calls)).toContain("transcript tick failed");
    expect(JSON.stringify(err.mock.calls)).toContain("TypeError");
    expect(JSON.stringify(err.mock.calls)).not.toContain("boom with detail");
  });

  it("still runs the transcript tick when the webhook tick fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    transcriptTick.mockResolvedValue({ outcome: "idle" });
    webhookTick.mockRejectedValue(new RangeError("kaboom with detail"));
    const results = await run();
    expect(transcriptTick).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(JSON.stringify(err.mock.calls)).toContain("webhook tick failed");
    expect(JSON.stringify(err.mock.calls)).not.toContain("kaboom with detail");
  });
});
