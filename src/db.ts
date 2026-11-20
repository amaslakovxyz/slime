import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA: Record<string, string[]> = {
  events: ["id", "tenant_id", "capacity", "price_cents"],
  tickets: ["id", "tenant_id", "event_id", "user_id", "qty", "promo_code", "total_cents"],
  promos: ["code", "tenant_id", "pct", "max_uses"],
};
export const PK: Record<string, string> = { events: "id", tickets: "id", promos: "code" };

export const DDL = `
CREATE TABLE events  (id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, capacity INTEGER NOT NULL, price_cents INTEGER NOT NULL);
CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, event_id INTEGER NOT NULL, user_id INTEGER NOT NULL, qty INTEGER NOT NULL, promo_code TEXT, total_cents INTEGER NOT NULL);
CREATE TABLE promos  (code TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, pct INTEGER NOT NULL, max_uses INTEGER NOT NULL);
`;

const SEED = `
INSERT INTO events VALUES (7, 1, 100, 5000), (8, 1, 2, 10000);
INSERT INTO promos VALUES ('FALL10', 1, 10, 100), ('BIG90', 1, 90, 100);
`;

export function createSeedDb(): Database {
  const db = new Database(":memory:");
  db.exec(DDL);
  db.exec(SEED);
  return db;
}

// Real application DB for the request path. Seeds only on first creation.
export function openAppDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'events'").get();
  if (!exists) { db.exec(DDL); db.exec(SEED); }
  return db;
}
