import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { badRequest, jsonResponse } from "./http.ts";

/**
 * When each tab was last open in this app, box by box (fork only: sahanh/herdr-web-ui).
 *
 * The launcher orders its Focus blocks by the workspace opened most recently. Kept here, in the
 * state dir, so every browser and device shares one order and it survives an update.
 *
 *   GET /api/mission-control/recent        { recent: { [machine]: { [workspace/tab]: ms } } }
 *   PUT /api/mission-control/recent/<id>   stamps the launcher's machine/workspace/tab as open now
 *
 * The server's clock stamps it, so devices with skewed clocks still agree. Each box keeps only
 * its most recent tabs, so one busy box never pushes another's out.
 */
export type Recent = Record<string, Record<string, number>>;

const ROUTE = "/api/mission-control/recent";
const ID_MAX = 256;
const PER_BOX = 200;
const BOXES_MAX = 100;

export class RecentStore {
  constructor(private readonly path: string) {}

  static inStateDir(stateDir: string): RecentStore {
    return new RecentStore(join(stateDir, "mission-control-recent.json"));
  }

  /** What is on disk; a missing or broken file is nothing opened yet, never an error. */
  read(): Recent {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.path, "utf8")); } catch { return {}; }
    const record = typeof raw === "object" && raw !== null ? (raw as { recent?: unknown }).recent : null;
    const recent: Recent = {};
    if (typeof record !== "object" || record === null) return recent;
    for (const [box, tabs] of Object.entries(record)) {
      if (typeof tabs !== "object" || tabs === null) continue;
      const kept: Record<string, number> = {};
      for (const [tab, at] of Object.entries(tabs)) {
        if (typeof at === "number" && Number.isFinite(at) && box.length + tab.length < ID_MAX) kept[tab] = at;
      }
      recent[box] = kept;
    }
    return recent;
  }

  private write(recent: Recent): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ recent }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** Null when a new box would go over the limit. */
  stamp(box: string, tab: string, at = Date.now()): number | null {
    const recent = this.read();
    if (!(box in recent) && Object.keys(recent).length >= BOXES_MAX) return null;
    const tabs = Object.entries({ ...recent[box], [tab]: at }).sort((a, b) => b[1] - a[1]).slice(0, PER_BOX);
    recent[box] = Object.fromEntries(tabs);
    this.write(recent);
    return at;
  }
}

export function isRecentPath(pathname: string): boolean {
  return pathname === ROUTE || pathname.startsWith(`${ROUTE}/`);
}

export function handleRecentRequest(request: Request, pathname: string, store: RecentStore): Response {
  const headers = { "cache-control": "no-store" };
  if (pathname === ROUTE) {
    if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "GET only" } }, 405);
    return jsonResponse({ recent: store.read() }, 200, headers);
  }
  if (request.method !== "PUT") return jsonResponse({ error: { code: "method_not_allowed", message: "PUT only" } }, 405);
  let id: string;
  try { id = decodeURIComponent(pathname.slice(ROUTE.length + 1)); } catch { return badRequest("invalid_id", "Malformed session id"); }
  const cut = id.indexOf("/");
  if (id.length > ID_MAX || cut < 1 || cut === id.length - 1) return badRequest("invalid_id", "Session id must be machine/workspace/tab, up to 256 characters");
  const at = store.stamp(id.slice(0, cut), id.slice(cut + 1));
  if (at === null) return badRequest("too_many", `At most ${BOXES_MAX} boxes`);
  return jsonResponse({ at }, 200, headers);
}
