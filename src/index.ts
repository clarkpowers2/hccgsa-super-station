import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { creator } from "./episodes";
import { signedViewUrl } from "./media";
import type { AppBindings } from "./types";

const app = new Hono<AppBindings>();

// Browser dashboard origins; override with a comma-separated CORS_ORIGINS var.
app.use(
  "/api/*",
  cors({
    origin: (origin, c) => {
      const allowed = (c.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((o: string) => o.trim());
      return allowed.includes(origin) ? origin : null;
    },
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);

app.get("/api/health", (c) => c.json({ status: "ok", environment: c.env.ENVIRONMENT }));
app.route("/api/auth", auth);
app.route("/api/creator", creator);

app.get("/api/episodes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.title, e.description, e.publish_date, e.view_count, u.creator_name
     FROM episodes e JOIN users u ON u.id = e.creator_id
     WHERE e.is_published = 1 ORDER BY e.publish_date DESC LIMIT 50`,
  ).all();
  return c.json({ episodes: results });
});

app.get("/api/episodes/:id", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT e.id, e.title, e.description, e.thumbnail_key, e.metadata_tags, e.publish_date, e.one_time_price_cents,
            e.view_count, e.transcript_status, u.creator_name
     FROM episodes e JOIN users u ON u.id = e.creator_id
     WHERE e.id = ? AND e.is_published = 1`,
  )
    .bind(c.req.param("id"))
    .first<Record<string, any>>();
  if (!r) return c.json({ error: "not found" }, 404);
  return c.json({
    id: r.id,
    title: r.title,
    description: r.description,
    tags: r.metadata_tags ? JSON.parse(r.metadata_tags) : [],
    publishDate: r.publish_date,
    oneTimePriceCents: r.one_time_price_cents,
    viewCount: r.view_count,
    creatorName: r.creator_name,
    thumbnailUrl: r.thumbnail_key ? await signedViewUrl(c.env, r.thumbnail_key) : null,
  });
});

app.onError((err, c) => {
  console.error("unhandled error", err.message); // never log request bodies or secrets
  return c.json({ error: "internal error" }, 500);
});

export default app;
