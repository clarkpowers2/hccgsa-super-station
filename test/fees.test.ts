import { describe, expect, it } from "vitest";
import { isValidFeePercent, splitAmount, sqlTime } from "../src/fees";

describe("split at a given rate", () => {
  it.each([
    [1000, 20, 200, 800],
    [499, 20, 100, 399], // 99.8 rounds to 100
    [499, 15, 75, 424], // 74.85 rounds to 75
    [500, 15, 75, 425],
    [499, 10, 50, 449], // 49.9 rounds to 50
    [50, 15, 8, 42], // 7.5 rounds half up
    [0, 15, 0, 0],
    [1, 15, 0, 1],
    [1000, 0, 0, 1000],
    [1000, 100, 1000, 0],
  ])("splits %i cents at %i%% into fee %i / creator %i", (gross, percent, fee, creator) => {
    expect(splitAmount(gross, percent)).toEqual({ grossCents: gross, platformFeeCents: fee, creatorCents: creator });
  });

  it("always sums to the gross amount and never goes negative, at every whole-percent rate", () => {
    for (let percent = 0; percent <= 100; percent++) {
      for (let g = 0; g <= 600; g++) {
        const s = splitAmount(g, percent);
        expect(s.platformFeeCents + s.creatorCents).toBe(g);
        expect(s.creatorCents).toBeGreaterThanOrEqual(0);
        expect(s.platformFeeCents).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("rejects non-integer or negative amounts", () => {
    expect(() => splitAmount(9.99, 15)).toThrow();
    expect(() => splitAmount(-1, 15)).toThrow();
  });

  it("requires an integer rate from 0 to 100, with no default", () => {
    for (const bad of [-1, 101, 12.5, Number.NaN, Infinity, "15" as any, null as any, undefined as any]) {
      expect(() => splitAmount(1000, bad), String(bad)).toThrow();
    }
    expect(() => (splitAmount as any)(1000)).toThrow(); // every caller passes the rate
  });
});

describe("isValidFeePercent", () => {
  // One assertion per case, so a failure names the value that broke (the old chained || / && hid which).
  it.each([0, 1, 15, 99, 100])("accepts the whole percent %s", (n) => {
    expect(isValidFeePercent(n)).toBe(true);
  });
  it.each([
    [-1, "below zero"],
    [101, "above 100"],
    [15.5, "fractional"],
    [Number.NaN, "NaN"],
    [Infinity, "Infinity"],
    ["15", "a numeric string"],
    [null, "null"],
    [undefined, "undefined"],
  ])("rejects %s (%s)", (n: unknown, _why: string) => {
    expect(isValidFeePercent(n)).toBe(false);
  });
});

describe("sqlTime", () => {
  it("formats unix seconds like SQLite datetime()", () => {
    expect(sqlTime(1760000000)).toBe("2025-10-09 08:53:20");
  });
});
