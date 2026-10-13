import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { badRequest, jsonResponse } from "./http.ts";

/**
 * Mission control's Focus and Watch picks (fork only: sahanh/herdr-web-ui).
 *
 * The launcher injected into this app keeps which sessions the user has in Focus or Watch.
 * They live here, in the state dir next to machines.json, so every browser and device sees
 * the same picks and they survive an update. A session not listed is in the default place.
 *
 *   GET    /api/mission-control/tiers         every pick: { tiers: { [id]: { tier, label, since } } }
 *   PUT    /api/mission-control/tiers/<id>    one pick: { tier, label }
 *   DELETE /api/mission-control/tiers/<id>    back to the default place
 *
 * One session per write, so two devices moving different sessions never undo each other.
 * The id is the launcher's machine/workspace/tab; the label is the tab's name when picked,
 * which tells a tab from a later one that reuses its id. The generic API checks (auth, same
 * origin for writes, watch-only devices) apply before these routes are reached.
 */
export type Tier = "focus" | "watch";
export interface Pick { tier: Tier; label: string; since: number }
export type Tiers = Record<string, Pick>;

const ROUTE = "/api/mission-control/tiers";
const ID_MAX = 256;
const LABEL_MAX = 200;
const PICKS_MAX = 1000;

function sanitizePick(raw: unknown): Pick | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { tier, label, since } = raw as Record<string, unknown>;
  if (tier !== "focus" && tier !== "watch") return null;
  if (typeof label !== "string" || label.length > LABEL_MAX) return null;
  return { tier, label, since: typeof since === "number" && Number.isFinite(since) ? since : Date.now() };
}

export class MissionControlStore {
  constructor(private readonly path: string) {}

  static inStateDir(stateDir: string): MissionControlStore {
    return new MissionControlStore(join(stateDir, "mission-control.json"));
  }

  /** What is on disk; a missing or broken file is no picks, never an error. */
  read(): Tiers {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.path, "utf8")); } catch { return {}; }
    const tiers: Tiers = {};
    const record = typeof raw === "object" && raw !== null ? (raw as { tiers?: unknown }).tiers : null;
    if (typeof record !== "object" || record === null) return tiers;
    for (const [id, value] of Object.entries(record)) {
      const pick = id.length <= ID_MAX ? sanitizePick(value) : null;
      if (pick) tiers[id] = pick;
    }
    return tiers;
  }

  private write(tiers: Tiers): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ tiers }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  set(id: string, tier: Tier, label: string): Pick {
    const tiers = this.read();
    const pick = { tier, label, since: tiers[id]?.tier === tier ? tiers[id]!.since : Date.now() };
    tiers[id] = pick;
    this.write(tiers);
    return pick;
  }

  remove(id: string): void {
    const tiers = this.read();
    if (!(id in tiers)) return;
    delete tiers[id];
    this.write(tiers);
  }
}

export function isMissionControlPath(pathname: string): boolean {
  return pathname === ROUTE || pathname.startsWith(`${ROUTE}/`);
}

export async function handleMissionControlRequest(request: Request, pathname: string, store: MissionControlStore): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (pathname === ROUTE) {
    if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "GET only" } }, 405);
    return jsonResponse({ tiers: store.read() }, 200, headers);
  }
  let id: string;
  try { id = decodeURIComponent(pathname.slice(ROUTE.length + 1)); } catch { return badRequest("invalid_id", "Malformed session id"); }
  if (!id || id.length > ID_MAX) return badRequest("invalid_id", "Session id must be 1-256 characters");
  if (request.method === "DELETE") {
    store.remove(id);
    return jsonResponse({ ok: true }, 200, headers);
  }
  if (request.method !== "PUT") return jsonResponse({ error: { code: "method_not_allowed", message: "PUT or DELETE" } }, 405);
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("invalid_json", "Body must be JSON"); }
  const pick = sanitizePick(body);
  if (!pick) return badRequest("invalid_pick", "tier must be focus or watch, label a string up to 200 characters");
  const current = store.read();
  if (!(id in current) && Object.keys(current).length >= PICKS_MAX) return badRequest("too_many", `At most ${PICKS_MAX} picks`);
  return jsonResponse({ pick: store.set(id, pick.tier, pick.label) }, 200, headers);
}
