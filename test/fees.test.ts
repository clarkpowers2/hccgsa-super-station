import { describe, expect, it } from "vitest";
import { splitAmount, sqlTime } from "../src/fees";

describe("80/20 split", () => {
  it.each([
    [1000, 200, 800],
    [499, 100, 399], // 99.8 rounds to 100
    [500, 100, 400],
    [50, 10, 40],
    [0, 0, 0],
    [1, 0, 1],
  ])("splits %i cents into fee %i / creator %i", (gross, fee, creator) => {
    expect(splitAmount(gross)).toEqual({ grossCents: gross, platformFeeCents: fee, creatorCents: creator });
  });

  it("always sums to the gross amount and never goes negative", () => {
    for (let g = 0; g <= 5000; g++) {
      const s = splitAmount(g);
      expect(s.platformFeeCents + s.creatorCents).toBe(g);
      expect(s.creatorCents).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects non-integers and negatives", () => {
    expect(() => splitAmount(9.99)).toThrow();
    expect(() => splitAmount(-1)).toThrow();
  });
});

describe("sqlTime", () => {
  it("formats unix seconds like SQLite datetime()", () => {
    expect(sqlTime(1760000000)).toBe("2025-10-09 08:53:20");
  });
});
