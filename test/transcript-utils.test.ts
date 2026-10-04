import { describe, expect, it } from "vitest";
import { buildTranscript, formatTimestamp, stripTimestamps, verifyQuotes } from "../src/transcript";

describe("formatTimestamp", () => {
  it.each([
    [0, "00:00:00"],
    [59.9, "00:00:59"],
    [61, "00:01:01"],
    [3725, "01:02:05"],
    [-5, "00:00:00"],
    [NaN, "00:00:00"],
  ])("%s -> %s", (s, out) => expect(formatTimestamp(s)).toBe(out));
});

describe("buildTranscript", () => {
  it("writes one timestamped line per segment and skips empty ones", () => {
    const t = buildTranscript("ignored", [
      { start: 0, end: 4, text: " Hello and welcome. " },
      { start: 4, end: 5, text: "   " },
      { start: 65, end: 70, text: "Second point." },
    ]);
    expect(t).toBe("[00:00:00] Hello and welcome.\n[00:01:05] Second point.");
    expect(stripTimestamps(t)).toBe("Hello and welcome.\nSecond point.");
  });
  it("falls back to plain text without segments", () => {
    expect(buildTranscript("  just text ", [])).toBe("just text");
    expect(buildTranscript("just text")).toBe("just text");
  });
});

describe("verifyQuotes", () => {
  const transcript = [
    "[00:00:05] Welcome back to the show everyone.",
    "[00:03:10] The most important thing about money is that it's a tool, not a goal.",
    "[00:07:42] Nobody tells you that failure is the cheapest tuition you'll ever pay.",
  ].join("\n");

  it("keeps verbatim quotes and takes the timestamp from the transcript", () => {
    const q = verifyQuotes(["Failure is the cheapest tuition you'll ever pay."], transcript);
    expect(q).toEqual([{ text: "Failure is the cheapest tuition you'll ever pay.", timestamp: "00:07:42" }]);
  });
  it("ignores case and punctuation differences", () => {
    expect(verifyQuotes(["it's a tool NOT a goal!"], transcript)[0]?.timestamp).toBe("00:03:10");
  });
  it("drops invented, paraphrased, and too-short quotes", () => {
    const q = verifyQuotes(["Money is basically just a tool you use", "Hello", "Failure is the best teacher there is, truly"], transcript);
    expect(q).toEqual([]);
  });
  it("never invents a timestamp: a quote spanning two lines gets the line holding its start, or null", () => {
    const q = verifyQuotes(["show everyone the most important thing about money"], transcript);
    expect(q).toHaveLength(1);
    expect(q[0]!.timestamp).toBe("00:00:05");
  });
  it("dedupes and caps at 3", () => {
    const t = Array.from({ length: 6 }, (_, i) => `[00:00:0${i}] This is memorable sentence number ${i} of the talk.`).join("\n");
    const cands = [0, 0, 1, 2, 3, 4, 5].map((i) => `This is memorable sentence number ${i} of the talk.`);
    expect(verifyQuotes(cands, t)).toHaveLength(3);
  });
  it("rejects quotes over 300 characters", () => {
    const long = "word ".repeat(80);
    expect(verifyQuotes([long], long)).toEqual([]);
  });
});
