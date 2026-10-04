import { Hono } from "hono";
import type { Context } from "hono";
import type { AppBindings } from "./types";
import { requireAuth, requireCreator } from "./auth";
import {
  MEDIA_POLICY,
  UPLOAD_URL_TTL_SECONDS,
  isMediaKind,
  keyPrefix,
  r2Configured,
  signedUploadUrl,
  signedViewUrl,
  type MediaKind,
} from "./media";

type Ctx = Context<AppBindings>;

interface EpisodeRow {
  id: string;
  creator_id: string;
  title: string;
  description: string | null;
  thumbnail_key: string | null;
  video_key: string | null;
  audio_key: string | null;
  transcript_status: string;
  metadata_tags: string | null;
  is_published: number;
  publish_date: string | null;
  one_time_price_cents: number | null;
  view_count: number;
  created_at: string;
  updated_at: string;
}

const MIN_PRICE_CENTS = 50; // Stripe's USD minimum charge
const MAX_PRICE_CENTS = 100_000;

async function shape(env: AppBindings["Bindings"], r: EpisodeRow) {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    tags: r.metadata_tags ? (JSON.parse(r.metadata_tags) as string[]) : [],
    isPublished: r.is_published === 1,
    publishDate: r.publish_date,
    oneTimePriceCents: r.one_time_price_cents,
    viewCount: r.view_count,
    transcriptStatus: r.transcript_status,
    hasVideo: r.video_key !== null,
    hasAudio: r.audio_key !== null,
    thumbnailUrl: r.thumbnail_key ? await signedViewUrl(env, r.thumbnail_key) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function findOwned(c: Ctx, episodeId: string) {
  return c.env.DB.prepare("SELECT * FROM episodes WHERE id = ? AND creator_id = ?")
    .bind(episodeId, c.get("user").sub)
    .first<EpisodeRow>();
}

function parseTags(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > 10) return null;
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== "string" || !t.trim() || t.trim().length > 30) return null;
    out.push(t.trim());
  }
  return out;
}

function parsePrice(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < MIN_PRICE_CENTS || v > MAX_PRICE_CENTS) return undefined;
  return v;
}

export const creator = new Hono<AppBindings>();
creator.use("*", requireAuth, requireCreator);

// ---- profile -------------------------------------------------------------

creator.get("/profile", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT id, email, creator_name, bio, avatar_url, stripe_account_id FROM users WHERE id = ?",
  )
    .bind(c.get("user").sub)
    .first<{ id: string; email: string; creator_name: string; bio: string | null; avatar_url: string | null; stripe_account_id: string | null }>();
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json({
    id: row.id,
    email: row.email,
    creatorName: row.creator_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    payoutsConnected: row.stripe_account_id !== null,
  });
});

creator.put("/profile", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { creatorName?: unknown; bio?: unknown };
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.creatorName !== undefined) {
    if (typeof body.creatorName !== "string" || !body.creatorName.trim() || body.creatorName.length > 80)
      return c.json({ error: "creatorName must be 1-80 characters" }, 400);
    sets.push("creator_name = ?");
    vals.push(body.creatorName.trim());
  }
  if (body.bio !== undefined) {
    if (typeof body.bio !== "string" || body.bio.length > 500) return c.json({ error: "bio must be at most 500 characters" }, 400);
    sets.push("bio = ?");
    vals.push(body.bio);
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...vals, c.get("user").sub)
    .run();
  return c.json({ ok: true });
});

// ---- episodes ------------------------------------------------------------

creator.post("/episodes", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: unknown;
    description?: unknown;
    tags?: unknown;
    oneTimePriceCents?: unknown;
  };
  if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 140)
    return c.json({ error: "title must be 1-140 characters" }, 400);
  if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 5000))
    return c.json({ error: "description must be at most 5000 characters" }, 400);
  const tags = body.tags === undefined ? [] : parseTags(body.tags);
  if (tags === null) return c.json({ error: "tags must be up to 10 strings of at most 30 characters" }, 400);
  const price = body.oneTimePriceCents === undefined ? null : parsePrice(body.oneTimePriceCents);
  if (price === undefined) return c.json({ error: `oneTimePriceCents must be an integer between ${MIN_PRICE_CENTS} and ${MAX_PRICE_CENTS}, or null` }, 400);

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO episodes (id, creator_id, title, description, metadata_tags, one_time_price_cents) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, c.get("user").sub, body.title.trim(), (body.description as string | undefined) ?? null, JSON.stringify(tags), price)
    .run();
  const row = (await findOwned(c, id))!;
  return c.json(await shape(c.env, row), 201);
});

creator.get("/episodes", async (c) => {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "25", 10) || 25, 1), 100);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const published = c.req.query("published");
  if (published !== undefined && published !== "true" && published !== "false")
    return c.json({ error: "published must be true or false" }, 400);
  const filter = published === undefined ? "" : " AND is_published = ?";
  const params: unknown[] = [c.get("user").sub];
  if (published !== undefined) params.push(published === "true" ? 1 : 0);
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM episodes WHERE creator_id = ?${filter} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
  )
    .bind(...params, limit, offset)
    .all<EpisodeRow>();
  return c.json({ episodes: await Promise.all(results.map((r) => shape(c.env, r))), limit, offset });
});

creator.get("/episodes/:id", async (c) => {
  const row = await findOwned(c, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(await shape(c.env, row));
});

creator.put("/episodes/:id", async (c) => {
  const row = await findOwned(c, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 140)
      return c.json({ error: "title must be 1-140 characters" }, 400);
    sets.push("title = ?");
    vals.push(body.title.trim());
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.length > 5000)
      return c.json({ error: "description must be at most 5000 characters" }, 400);
    sets.push("description = ?");
    vals.push(body.description);
  }
  if (body.tags !== undefined) {
    const tags = parseTags(body.tags);
    if (tags === null) return c.json({ error: "tags must be up to 10 strings of at most 30 characters" }, 400);
    sets.push("metadata_tags = ?");
    vals.push(JSON.stringify(tags));
  }
  if (body.oneTimePriceCents !== undefined) {
    const price = parsePrice(body.oneTimePriceCents);
    if (price === undefined) return c.json({ error: `oneTimePriceCents must be an integer between ${MIN_PRICE_CENTS} and ${MAX_PRICE_CENTS}, or null` }, 400);
    sets.push("one_time_price_cents = ?");
    vals.push(price);
  }
  if (body.isPublished !== undefined) {
    if (typeof body.isPublished !== "boolean") return c.json({ error: "isPublished must be a boolean" }, 400);
    if (body.isPublished && !row.video_key && !row.audio_key)
      return c.json({ error: "upload a video or audio file before publishing" }, 409);
    sets.push("is_published = ?");
    vals.push(body.isPublished ? 1 : 0);
    if (body.isPublished && !row.publish_date) sets.push("publish_date = datetime('now')");
  }
  if (!sets.length) return c.json({ error: "nothing to update" }, 400);

  await c.env.DB.prepare(`UPDATE episodes SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ? AND creator_id = ?`)
    .bind(...vals, row.id, row.creator_id)
    .run();
  return c.json(await shape(c.env, (await findOwned(c, row.id))!));
});

// ---- uploads -------------------------------------------------------------

// Step 1: ask for a presigned PUT URL. The browser then uploads straight to R2.
creator.post("/episodes/:id/uploads", async (c) => {
  const row = await findOwned(c, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  if (!r2Configured(c.env)) return c.json({ error: "storage not configured" }, 503);

  const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown; contentType?: unknown; sizeBytes?: unknown };
  if (!isMediaKind(body.kind)) return c.json({ error: "kind must be video, audio or thumbnail" }, 400);
  const policy = MEDIA_POLICY[body.kind];
  if (typeof body.contentType !== "string" || !Object.prototype.hasOwnProperty.call(policy.types, body.contentType))
    return c.json({ error: `unsupported contentType for ${body.kind}`, allowed: Object.keys(policy.types) }, 400);
  if (typeof body.sizeBytes !== "number" || !Number.isInteger(body.sizeBytes) || body.sizeBytes <= 0)
    return c.json({ error: "sizeBytes must be a positive integer" }, 400);
  if (body.sizeBytes > policy.maxBytes) return c.json({ error: "file too large", maxBytes: policy.maxBytes }, 413);

  const key = `${keyPrefix(row.creator_id, row.id, body.kind)}${crypto.randomUUID()}.${policy.types[body.contentType]}`;
  const uploadUrl = await signedUploadUrl(c.env, key, body.contentType);
  return c.json({
    key,
    uploadUrl,
    method: "PUT",
    headers: { "Content-Type": body.contentType },
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });
});

// Step 2: after the browser finishes the PUT, confirm it. We check R2 ourselves
// rather than trusting the client.
creator.post("/episodes/:id/uploads/complete", async (c) => {
  const row = await findOwned(c, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { kind?: unknown; key?: unknown };
  if (!isMediaKind(body.kind)) return c.json({ error: "kind must be video, audio or thumbnail" }, 400);
  const kind: MediaKind = body.kind;
  const policy = MEDIA_POLICY[kind];
  if (typeof body.key !== "string" || !body.key.startsWith(keyPrefix(row.creator_id, row.id, kind)) || body.key.includes(".."))
    return c.json({ error: "key does not belong to this episode" }, 400);

  const obj = await c.env.MEDIA.head(body.key);
  if (!obj) return c.json({ error: "upload not found in storage" }, 409);

  const contentType = obj.httpMetadata?.contentType ?? "";
  if (obj.size > policy.maxBytes || !Object.prototype.hasOwnProperty.call(policy.types, contentType)) {
    await c.env.MEDIA.delete(body.key);
    return c.json({ error: "uploaded object rejected (size or type not allowed)" }, 422);
  }

  const previous = row[policy.column];
  await c.env.DB.prepare(`UPDATE episodes SET ${policy.column} = ?, updated_at = datetime('now') WHERE id = ? AND creator_id = ?`)
    .bind(body.key, row.id, row.creator_id)
    .run();
  if (previous && previous !== body.key) {
    try {
      await c.env.MEDIA.delete(previous);
    } catch {
      console.error("failed to delete replaced media object");
    }
  }
  return c.json(await shape(c.env, (await findOwned(c, row.id))!));
});

// Owner-only preview link (public/paid playback arrives with Stripe, milestone 3).
creator.get("/episodes/:id/media/:kind", async (c) => {
  const row = await findOwned(c, c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  const kind = c.req.param("kind");
  if (!isMediaKind(kind)) return c.json({ error: "kind must be video, audio or thumbnail" }, 400);
  const key = row[MEDIA_POLICY[kind].column];
  if (!key) return c.json({ error: "no file uploaded" }, 404);
  const url = await signedViewUrl(c.env, key, 15 * 60);
  if (!url) return c.json({ error: "storage not configured" }, 503);
  return c.json({ url, expiresInSeconds: 15 * 60 });
});

// ---- analytics -----------------------------------------------------------

creator.get("/analytics", async (c) => {
  const id = c.get("user").sub;
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(is_published), 0) AS published, COALESCE(SUM(view_count), 0) AS views
     FROM episodes WHERE creator_id = ?`,
  )
    .bind(id)
    .first<{ total: number; published: number; views: number }>();
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, view_count FROM episodes WHERE creator_id = ? ORDER BY view_count DESC, id LIMIT 5",
  )
    .bind(id)
    .all<{ id: string; title: string; view_count: number }>();
  return c.json({
    totalEpisodes: totals?.total ?? 0,
    publishedEpisodes: totals?.published ?? 0,
    draftEpisodes: (totals?.total ?? 0) - (totals?.published ?? 0),
    totalViews: totals?.views ?? 0,
    topEpisodes: results.map((r) => ({ id: r.id, title: r.title, viewCount: r.view_count })),
  });
});
