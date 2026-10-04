import { Hono } from "hono";
import { auth } from "./auth";
import type { AppBindings } from "./types";

const app = new Hono<AppBindings>();

app.get("/api/health", (c) => c.json({ status: "ok", environment: c.env.ENVIRONMENT }));
app.route("/api/auth", auth);

app.get("/api/episodes", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.title, e.description, e.publish_date, e.view_count, u.creator_name
     FROM episodes e JOIN users u ON u.id = e.creator_id
     WHERE e.is_published = 1 ORDER BY e.publish_date DESC LIMIT 50`,
  ).all();
  return c.json({ episodes: results });
});

app.onError((err, c) => {
  console.error("unhandled error", err.message); // never log request bodies or secrets
  return c.json({ error: "internal error" }, 500);
});

export default app;
