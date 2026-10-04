import { describe, expect, it } from "vitest";
import { call, makeEnv, registerCreator } from "./helpers";

async function setup() {
  const t = makeEnv();
  const me = await registerCreator(t.env);
  const ep = await call(t.env, "POST", "/api/creator/episodes", { token: me.token, body: { title: "Pilot", tags: ["news"] } });
  return { ...t, me, episodeId: ep.json.id as string };
}

const requestUpload = (env: any, token: string, id: string, body: unknown) =>
  call(env, "POST", `/api/creator/episodes/${id}/uploads`, { token, body });

describe("access control", () => {
  it("requires a token and a creator account", async () => {
    const { env } = makeEnv();
    expect((await call(env, "GET", "/api/creator/episodes")).status).toBe(401);
    const viewer = await call(env, "POST", "/api/auth/register", {
      body: { email: "v@example.com", password: "a-long-test-password", creatorName: "V" },
    });
    expect((await call(env, "GET", "/api/creator/episodes", { token: viewer.json.token })).status).toBe(403);
  });

  it("hides one creator's episodes from another", async () => {
    const { env, episodeId } = await setup();
    const other = await registerCreator(env, "other@example.com");
    expect((await call(env, "GET", `/api/creator/episodes/${episodeId}`, { token: other.token })).status).toBe(404);
    expect((await call(env, "PUT", `/api/creator/episodes/${episodeId}`, { token: other.token, body: { title: "hijack" } })).status).toBe(404);
    expect((await requestUpload(env, other.token, episodeId, { kind: "video", contentType: "video/mp4", sizeBytes: 10 })).status).toBe(404);
    expect((await call(env, "GET", "/api/creator/episodes", { token: other.token })).json.episodes).toHaveLength(0);
  });
});

describe("episode management", () => {
  it("creates, lists, and updates an episode", async () => {
    const { env, me, episodeId } = await setup();
    const list = await call(env, "GET", "/api/creator/episodes", { token: me.token });
    expect(list.json.episodes).toHaveLength(1);
    expect(list.json.episodes[0]).toMatchObject({ title: "Pilot", tags: ["news"], isPublished: false, hasVideo: false });

    const drafts = await call(env, "GET", "/api/creator/episodes?published=false", { token: me.token });
    expect(drafts.json.episodes).toHaveLength(1);
    const live = await call(env, "GET", "/api/creator/episodes?published=true", { token: me.token });
    expect(live.json.episodes).toHaveLength(0);
    expect((await call(env, "GET", "/api/creator/episodes?published=maybe", { token: me.token })).status).toBe(400);

    const upd = await call(env, "PUT", `/api/creator/episodes/${episodeId}`, {
      token: me.token,
      body: { title: "Pilot v2", oneTimePriceCents: 499 },
    });
    expect(upd.json).toMatchObject({ title: "Pilot v2", oneTimePriceCents: 499 });
  });

  it("validates input", async () => {
    const { env, me, episodeId } = await setup();
    const bad = (body: unknown) => call(env, "POST", "/api/creator/episodes", { token: me.token, body });
    expect((await bad({ title: "" })).status).toBe(400);
    expect((await bad({ title: "x", oneTimePriceCents: 9.99 })).status).toBe(400);
    expect((await bad({ title: "x", oneTimePriceCents: 10 })).status).toBe(400); // below Stripe minimum
    expect((await bad({ title: "x", tags: Array(11).fill("a") })).status).toBe(400);
    expect((await call(env, "PUT", `/api/creator/episodes/${episodeId}`, { token: me.token, body: {} })).status).toBe(400);
  });

  it("refuses to publish an episode with no media", async () => {
    const { env, me, episodeId } = await setup();
    const r = await call(env, "PUT", `/api/creator/episodes/${episodeId}`, { token: me.token, body: { isPublished: true } });
    expect(r.status).toBe(409);
  });
});

describe("upload flow", () => {
  it("issues a presigned PUT URL scoped to this creator and episode", async () => {
    const { env, me, episodeId } = await setup();
    const r = await requestUpload(env, me.token, episodeId, { kind: "video", contentType: "video/mp4", sizeBytes: 1000 });
    expect(r.status).toBe(200);
    expect(r.json.key).toMatch(new RegExp(`^${me.id}/${episodeId}/video/[0-9a-f-]+\\.mp4$`));
    const url = new URL(r.json.uploadUrl);
    expect(url.host).toBe("testaccount.r2.cloudflarestorage.com");
    expect(url.pathname).toBe(`/testbucket/${r.json.key}`);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(r.json.headers).toEqual({ "Content-Type": "video/mp4" });
    expect(r.json.uploadUrl).not.toContain("testsecret"); // secret never leaves the server
  });

  it("rejects bad kind, content type, and oversize files", async () => {
    const { env, me, episodeId } = await setup();
    expect((await requestUpload(env, me.token, episodeId, { kind: "exe", contentType: "video/mp4", sizeBytes: 1 })).status).toBe(400);
    expect((await requestUpload(env, me.token, episodeId, { kind: "video", contentType: "text/html", sizeBytes: 1 })).status).toBe(400);
    expect((await requestUpload(env, me.token, episodeId, { kind: "video", contentType: "video/mp4", sizeBytes: 0 })).status).toBe(400);
    expect((await requestUpload(env, me.token, episodeId, { kind: "thumbnail", contentType: "image/png", sizeBytes: 6 * 1024 * 1024 })).status).toBe(413);
  });

  it("returns 503 when storage credentials are missing", async () => {
    const t = makeEnv({ R2_SECRET_ACCESS_KEY: "" });
    const me = await registerCreator(t.env);
    const ep = await call(t.env, "POST", "/api/creator/episodes", { token: me.token, body: { title: "x" } });
    expect((await requestUpload(t.env, me.token, ep.json.id, { kind: "video", contentType: "video/mp4", sizeBytes: 1 })).status).toBe(503);
  });

  it("completes an upload, then allows publishing", async () => {
    const { env, objects, me, episodeId } = await setup();
    const up = await requestUpload(env, me.token, episodeId, { kind: "video", contentType: "video/mp4", sizeBytes: 1000 });
    objects.set(up.json.key, { size: 1000, httpMetadata: { contentType: "video/mp4" } }); // browser PUT to R2

    const done = await call(env, "POST", `/api/creator/episodes/${episodeId}/uploads/complete`, {
      token: me.token,
      body: { kind: "video", key: up.json.key },
    });
    expect(done.status).toBe(200);
    expect(done.json.hasVideo).toBe(true);

    const pub = await call(env, "PUT", `/api/creator/episodes/${episodeId}`, { token: me.token, body: { isPublished: true } });
    expect(pub.status).toBe(200);
    expect(pub.json.isPublished).toBe(true);
    expect(pub.json.publishDate).toBeTruthy();

    const publicList = await call(env, "GET", "/api/episodes");
    expect(publicList.json.episodes).toHaveLength(1);
    const publicOne = await call(env, "GET", `/api/episodes/${episodeId}`);
    expect(publicOne.status).toBe(200);
    expect(JSON.stringify(publicOne.json)).not.toContain(".mp4"); // storage keys are never exposed publicly
  });

  it("rejects completion when nothing was uploaded", async () => {
    const { env, me, episodeId } = await setup();
    const up = await requestUpload(env, me.token, episodeId, { kind: "audio", contentType: "audio/mpeg", sizeBytes: 10 });
    const r = await call(env, "POST", `/api/creator/episodes/${episodeId}/uploads/complete`, { token: me.token, body: { kind: "audio", key: up.json.key } });
    expect(r.status).toBe(409);
  });

  it("rejects keys from another creator, another episode, or path tricks", async () => {
    const { env, objects, me, episodeId } = await setup();
    const other = await registerCreator(env, "other@example.com");
    const otherEp = await call(env, "POST", "/api/creator/episodes", { token: other.token, body: { title: "theirs" } });
    const theirKey = `${other.id}/${otherEp.json.id}/video/x.mp4`;
    objects.set(theirKey, { size: 5, httpMetadata: { contentType: "video/mp4" } });

    const complete = (key: string, kind = "video") =>
      call(env, "POST", `/api/creator/episodes/${episodeId}/uploads/complete`, { token: me.token, body: { kind, key } });
    expect((await complete(theirKey)).status).toBe(400);
    expect((await complete(`${me.id}/${episodeId}/audio/x.mp3`)).status).toBe(400); // wrong kind prefix
    expect((await complete(`${me.id}/${episodeId}/video/../../${other.id}/${otherEp.json.id}/video/x.mp4`)).status).toBe(400);
  });

  it("deletes and rejects an uploaded object with a disallowed type or size", async () => {
    const { env, objects, me, episodeId } = await setup();
    const up = await requestUpload(env, me.token, episodeId, { kind: "thumbnail", contentType: "image/png", sizeBytes: 100 });
    objects.set(up.json.key, { size: 100, httpMetadata: { contentType: "text/html" } });
    const r = await call(env, "POST", `/api/creator/episodes/${episodeId}/uploads/complete`, { token: me.token, body: { kind: "thumbnail", key: up.json.key } });
    expect(r.status).toBe(422);
    expect(objects.has(up.json.key)).toBe(false);
  });

  it("replaces media and deletes the old object", async () => {
    const { env, objects, me, episodeId } = await setup();
    const keys: string[] = [];
    for (let n = 0; n < 2; n++) {
      const up = await requestUpload(env, me.token, episodeId, { kind: "audio", contentType: "audio/mpeg", sizeBytes: 10 });
      objects.set(up.json.key, { size: 10, httpMetadata: { contentType: "audio/mpeg" } });
      await call(env, "POST", `/api/creator/episodes/${episodeId}/uploads/complete`, { token: me.token, body: { kind: "audio", key: up.json.key } });
      keys.push(up.json.key);
    }
    expect(objects.has(keys[0]!)).toBe(false);
    expect(objects.has(keys[1]!)).toBe(true);
  });

  it("gives the owner a signed preview URL only for uploaded media", async () => {
    const { env, objects, me, episodeId } = await setup();
    expect((await call(env, "GET", `/api/creator/episodes/${episodeId}/media/video`, { token: me.token })).status).toBe(404);
    const up = await requestUpload(env, me.token, episodeId, { kind: "video", contentType: "video/webm", sizeBytes: 10 });
    objects.set(up.json.key, { size: 10, httpMetadata: { contentType: "video/webm" } });
    await call(env, "POST", `/api/creator/episodes/${episodeId}/uploads/complete`, { token: me.token, body: { kind: "video", key: up.json.key } });
    const r = await call(env, "GET", `/api/creator/episodes/${episodeId}/media/video`, { token: me.token });
    expect(r.status).toBe(200);
    expect(new URL(r.json.url).searchParams.get("X-Amz-Expires")).toBe("900");
  });
});

describe("dashboard", () => {
  it("returns profile, thumbnail URLs in the list, and analytics", async () => {
    const { env, objects, me, episodeId } = await setup();
    const up = await requestUpload(env, me.token, episodeId, { kind: "thumbnail", contentType: "image/jpeg", sizeBytes: 10 });
    objects.set(up.json.key, { size: 10, httpMetadata: { contentType: "image/jpeg" } });
    await call(env, "POST", `/api/creator/episodes/${episodeId}/uploads/complete`, { token: me.token, body: { kind: "thumbnail", key: up.json.key } });

    const list = await call(env, "GET", "/api/creator/episodes", { token: me.token });
    expect(list.json.episodes[0].thumbnailUrl).toContain("X-Amz-Signature=");

    const profile = await call(env, "PUT", "/api/creator/profile", { token: me.token, body: { bio: "Hello" } });
    expect(profile.status).toBe(200);
    expect((await call(env, "GET", "/api/creator/profile", { token: me.token })).json).toMatchObject({ bio: "Hello", payoutsConnected: false });

    const stats = await call(env, "GET", "/api/creator/analytics", { token: me.token });
    expect(stats.json).toMatchObject({ totalEpisodes: 1, publishedEpisodes: 0, draftEpisodes: 1, totalViews: 0 });
  });
});
