import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { creator } from "./episodes";
import { publicApi, publishedEpisodeView } from "./public";
import { networks } from "./networks";
import type { AppBindings } from "./types";

const app = new Hono<AppBindings>();

// Browser dashboard origins; override with a comma-separated CORS_ORIGINS var.
const dashboardCors = cors({
  origin: (origin, c) => {
    const allowed = (c.env.CORS_ORIGINS ?? "http://localhost:3000").split(",").map((o: string) => o.trim());
    return allowed.includes(origin) ? origin : null;
  },
  allowHeaders: ["Authorization", "Content-Type"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});
// /api/public/* sets its own open CORS (bearer-key auth, no cookies).
app.use("/api/*", (c, next) => (c.req.path.startsWith("/api/public/") ? next() : dashboardCors(c, next)));

app.get("/api/health", (c) => c.json({ status: "ok", environment: c.env.ENVIRONMENT }));
app.route("/api/auth", auth);
app.route("/api/creator", creator);
app.route("/api/networks", networks);
app.route("/api/public", publicApi);

app.get("/api/episodes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.title, e.description, e.publish_date, e.view_count, u.creator_name
     FROM episodes e JOIN users u ON u.id = e.creator_id
     WHERE e.is_published = 1 ORDER BY e.publish_date DESC LIMIT 50`,
  ).all();
  return c.json({ episodes: results });
});

app.get("/api/episodes/:id", async (c) => {
  const ep = await publishedEpisodeView(c.env, c.req.param("id"));
  return ep ? c.json(ep) : c.json({ error: "not found" }, 404);
});

app.onError((err, c) => {
  console.error("unhandled error", err.message); // never log request bodies or secrets
  return c.json({ error: "internal error" }, 500);
});

export default app;
