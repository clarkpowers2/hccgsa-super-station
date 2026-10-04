import { describe, expect, it } from "vitest";
import { encodeParams, verifyStripeSignature } from "../src/stripe";
import { stripeSignatureHeader } from "./helpers";

describe("encodeParams", () => {
  it("encodes nested objects and arrays the way Stripe expects", () => {
    const qs = new URLSearchParams(
      encodeParams({
        mode: "payment",
        line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 499 } }],
        payment_intent_data: { metadata: { episode_id: "e 1" } },
        skip: undefined,
        alsoSkip: null,
      }),
    );
    expect(Object.fromEntries(qs)).toEqual({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "499",
      "payment_intent_data[metadata][episode_id]": "e 1",
    });
  });
});

describe("verifyStripeSignature", () => {
  const secret = "test-secret";
  const payload = '{"id":"evt_1"}';
  const now = 1_760_000_000;

  it("accepts a valid signature", async () => {
    expect(await verifyStripeSignature(payload, stripeSignatureHeader(payload, secret, now), secret, 300, now)).toBe(true);
  });
  it("rejects a tampered payload, wrong secret, and empty secret", async () => {
    const h = stripeSignatureHeader(payload, secret, now);
    expect(await verifyStripeSignature(payload + " ", h, secret, 300, now)).toBe(false);
    expect(await verifyStripeSignature(payload, h, "other-secret", 300, now)).toBe(false);
    expect(await verifyStripeSignature(payload, h, "", 300, now)).toBe(false);
  });
  it("rejects stale and far-future timestamps (replay protection)", async () => {
    expect(await verifyStripeSignature(payload, stripeSignatureHeader(payload, secret, now - 301), secret, 300, now)).toBe(false);
    expect(await verifyStripeSignature(payload, stripeSignatureHeader(payload, secret, now + 301), secret, 300, now)).toBe(false);
    expect(await verifyStripeSignature(payload, stripeSignatureHeader(payload, secret, now - 299), secret, 300, now)).toBe(true);
  });
  it("rejects missing or malformed headers", async () => {
    for (const h of [undefined, "", "garbage", "t=abc,v1=00", `t=${now}`, `v1=00`]) {
      expect(await verifyStripeSignature(payload, h, secret, 300, now)).toBe(false);
    }
  });
  it("accepts when any one of several v1 signatures matches", async () => {
    const good = stripeSignatureHeader(payload, secret, now).split("v1=")[1];
    expect(await verifyStripeSignature(payload, `t=${now},v1=${"0".repeat(64)},v1=${good}`, secret, 300, now)).toBe(true);
  });
});
