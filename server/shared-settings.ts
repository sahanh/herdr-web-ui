import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { badRequest, isJsonObject, jsonResponse } from "./http.ts";

/**
 * The settings every browser shares (fork only: sahanh/herdr-web-ui). One record in the state
 * dir next to machines.json, so typography, theme and the rest follow the user to every browser
 * and device, whichever PC they look at. The client keeps what is this device's own (its alerts,
 * key bar, wake lock) out of it, and sanitizes what it reads (src/lib/settings.ts); this store
 * only keeps an object of a bounded size.
 *
 *   GET /api/mission-control/settings   { settings: {...} | null, updated: <ms> | null }
 *   PUT /api/mission-control/settings   the whole shared record: { settings: {...} }
 *
 * The generic API checks (auth, same origin for writes, watch-only devices) apply before this
 * route is reached.
 */
const ROUTE = "/api/mission-control/settings";
const BODY_MAX = 64 * 1024;

export interface SharedSettings { settings: Record<string, unknown> | null; updated: number | null }

export class SharedSettingsStore {
  constructor(private readonly path: string) {}

  static inStateDir(stateDir: string): SharedSettingsStore {
    return new SharedSettingsStore(join(stateDir, "settings.json"));
  }

  /** What is on disk; a missing or broken file is no settings yet, never an error. */
  read(): SharedSettings {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.path, "utf8")); } catch { return { settings: null, updated: null }; }
    if (!isJsonObject(raw) || !isJsonObject(raw["settings"])) return { settings: null, updated: null };
    return { settings: raw["settings"], updated: typeof raw["updated"] === "number" ? raw["updated"] : null };
  }

  write(settings: Record<string, unknown>): SharedSettings {
    const record = { settings, updated: Date.now() };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    return record;
  }
}

export function isSharedSettingsPath(pathname: string): boolean {
  return pathname === ROUTE;
}

export async function handleSharedSettingsRequest(request: Request, store: SharedSettingsStore): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (request.method === "GET") return jsonResponse(store.read(), 200, headers);
  if (request.method !== "PUT") return jsonResponse({ error: { code: "method_not_allowed", message: "GET or PUT" } }, 405);
  const text = await request.text();
  if (text.length > BODY_MAX) return badRequest("too_large", `Settings must be under ${BODY_MAX} bytes`);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return badRequest("invalid_json", "Body must be JSON"); }
  if (!isJsonObject(body) || !isJsonObject(body["settings"])) return badRequest("invalid_settings", "Body must be { settings: {...} }");
  return jsonResponse(store.write(body["settings"]), 200, headers);
}
