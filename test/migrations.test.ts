import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const sql = (f: string) => readFileSync(`migrations/${f}`, "utf8");

describe("0004_multi_network", () => {
  it("backfills Phase 1 rows into the FREQ ONE network", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(sql("0001_init.sql"));
    db.exec("INSERT INTO users (id,email,password_hash,creator_name,is_creator) VALUES ('u1','a@x.co','h','A',1),('u2','b@x.co','h','B',0)");
    db.exec("INSERT INTO episodes (id,creator_id,title) VALUES ('e1','u1','T')");
    db.exec(sql("0004_multi_network.sql"));
    expect(db.prepare("SELECT network_id, role FROM users ORDER BY id").all()).toEqual([
      { network_id: "net_freqone", role: "owner" },
      { network_id: "net_freqone", role: "guest" },
    ]);
    expect(db.prepare("SELECT network_id FROM episodes").get()).toEqual({ network_id: "net_freqone" });
    expect(db.prepare("SELECT owner_id, status FROM networks").get()).toEqual({ owner_id: "u1", status: "active" });
  });

  it("applies cleanly on an empty database and rejects bad enum values", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(sql("0001_init.sql"));
    db.exec(sql("0004_multi_network.sql"));
    expect(() => db.exec("INSERT INTO networks (id,slug,display_name,status) VALUES ('n','s','S','bogus')")).toThrow();
  });
});

describe("0007_webhook_delivery", () => {
  const upTo = (last: string) => {
    const db = new DatabaseSync(":memory:");
    for (const f of readdirSync("migrations").filter((n) => n < last).sort()) db.exec(sql(f));
    return db;
  };

  it("disables existing webhooks, drops the plaintext secret, and keeps url/events", () => {
    const db = upTo("0007");
    // Production-shaped row: a webhook registered under 0005 with a plaintext secret.
    db.exec("INSERT INTO users (id,email,password_hash,creator_name,is_creator,network_id,role) VALUES ('u9','w@x.co','h','W',1,'net_freqone','owner')");
    db.exec("INSERT INTO webhooks (id,network_id,url,events,secret,created_by) VALUES ('w1','net_freqone','https://hooks.example.com/in','[\"episode.created\"]','whsec_placeholder_not_real','u9')");
    expect(db.prepare("SELECT secret FROM webhooks WHERE id='w1'").get()).toEqual({ secret: "whsec_placeholder_not_real" });

    db.exec(sql("0007_webhook_delivery.sql"));

    expect(db.prepare("SELECT status, secret_ciphertext, url, events FROM webhooks WHERE id='w1'").get()).toEqual({
      status: "disabled",
      secret_ciphertext: null,
      url: "https://hooks.example.com/in",
      events: '["episode.created"]',
    });
    const cols = (db.prepare("PRAGMA table_info(webhooks)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("secret");
    expect(cols).toContain("secret_ciphertext");
    // The plaintext value must be gone from every column of every row, not just renamed.
    expect(JSON.stringify(db.prepare("SELECT * FROM webhooks").all())).not.toContain("whsec_placeholder_not_real");
  });

  it("registrations made after the migration default to active, and the status enum is enforced", () => {
    const db = upTo("0007");
    db.exec("INSERT INTO users (id,email,password_hash,creator_name,is_creator,network_id,role) VALUES ('u9','w@x.co','h','W',1,'net_freqone','owner')");
    db.exec(sql("0007_webhook_delivery.sql"));
    db.exec("INSERT INTO webhooks (id,network_id,url,events,secret_ciphertext,created_by) VALUES ('w2','net_freqone','https://hooks.example.com/in','[]','ct','u9')");
    expect(db.prepare("SELECT status FROM webhooks WHERE id='w2'").get()).toEqual({ status: "active" });
    expect(() => db.exec("UPDATE webhooks SET status='bogus' WHERE id='w2'")).toThrow();
  });
});
