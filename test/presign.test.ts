import { describe, expect, it } from "vitest";
import { presignUrl } from "../src/presign";

describe("SigV4 presign", () => {
  // Official AWS docs example: "Authenticating Requests: Using Query Parameters".
  it("matches the AWS published test vector", async () => {
    const url = await presignUrl({
      method: "GET",
      host: "examplebucket.s3.amazonaws.com",
      path: "/test.txt",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      expiresSeconds: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(new URL(url).searchParams.get("X-Amz-Signature")).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("signs the content-type header when given", async () => {
    const url = new URL(
      await presignUrl({
        method: "PUT",
        host: "h.example.com",
        path: "/b/k.mp4",
        accessKeyId: "A",
        secretAccessKey: "S",
        region: "auto",
        expiresSeconds: 60,
        signedHeaders: { "Content-Type": "video/mp4" },
        now: new Date("2026-01-01T00:00:00Z"),
      }),
    );
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
  });
});
