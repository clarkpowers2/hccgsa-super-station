import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth";
import { creator } from "./episodes";
import { billing } from "./billing";
import { creatorBilling } from "./creator-billing";
import { webhooks } from "./webhooks";
import { StripeError } from "./stripe";
import { processNextTranscript } from "./pipeline";
import type { Env } from "./types";
import { signedViewUrl } from "./media";
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
app.route("/api/creator", creatorBilling);
app.route("/api", billing);
app.route("/api/webhooks", webhooks);
app.route("/api/networks", networks);
app.route("/api/public", publicApi);

app.get("/api/episodes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.title, e.description, e.summary, e.publish_date, e.view_count, u.creator_name
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
  if (err instanceof StripeError) {
    console.error("stripe error", err.status, err.code); // code only: messages can echo request details
    return c.json({ error: "payment provider error" }, 502);
  }
  console.error("unhandled error", err.message); // never log request bodies or secrets
  return c.json({ error: "internal error" }, 500);
});

export default {
  fetch: app.fetch,
  // Cron (every minute, see wrangler.toml): work through the transcription queue, one episode per tick.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(processNextTranscript(env).catch((e) => console.error("transcript tick failed", e instanceof Error ? e.constructor.name : "unknown")));
  },
};
export { app };
