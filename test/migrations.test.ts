import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

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
