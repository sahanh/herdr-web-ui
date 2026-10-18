import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { TabGroup } from "../shared/tab-groups.ts";
import { badRequest, jsonResponse } from "./http.ts";

/**
 * Tab groups, kept in the state dir next to machines.json (fork only; the contract is in
 * shared/tab-groups.ts). The generic API checks (auth, same origin for writes, watch-only
 * devices) apply before these routes are reached.
 */
const ROUTE = "/api/mission-control/tab-groups";
const ID_MAX = 64;
const FIELD_MAX = 256;
const NAME_MAX = 80;
const TABS_MAX = 200;
const GROUPS_MAX = 500;

type Groups = Record<string, TabGroup>;

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function sanitizeGroup(raw: unknown): TabGroup | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { machine_id, workspace_id, name, tab_ids } = raw as Record<string, unknown>;
  if (!text(machine_id, FIELD_MAX) || !text(workspace_id, FIELD_MAX)) return null;
  if (typeof name !== "string" || !text(name.trim(), NAME_MAX)) return null;
  if (!Array.isArray(tab_ids) || tab_ids.length > TABS_MAX || !tab_ids.every((id) => text(id, FIELD_MAX))) return null;
  return { machine_id, workspace_id, name: name.trim(), tab_ids: [...new Set(tab_ids as string[])] };
}

export class TabGroupStore {
  constructor(private readonly path: string) {}

  static inStateDir(stateDir: string): TabGroupStore {
    return new TabGroupStore(join(stateDir, "tab-groups.json"));
  }

  /** What is on disk; a missing or broken file is no groups, never an error. */
  read(): Groups {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(this.path, "utf8")); } catch { return {}; }
    const groups: Groups = {};
    const record = typeof raw === "object" && raw !== null ? (raw as { groups?: unknown }).groups : null;
    if (typeof record !== "object" || record === null) return groups;
    for (const [id, value] of Object.entries(record)) {
      const group = id.length <= ID_MAX ? sanitizeGroup(value) : null;
      if (group && group.tab_ids.length > 0) groups[id] = group;
    }
    return groups;
  }

  private write(groups: Groups): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ groups }), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** The group as given, its tabs taken out of the PC's other groups; an empty one is removed. */
  set(id: string, group: TabGroup): Groups {
    const groups = this.read();
    const taken = new Set(group.tab_ids);
    for (const [otherId, other] of Object.entries(groups)) {
      if (otherId === id || other.machine_id !== group.machine_id) continue;
      other.tab_ids = other.tab_ids.filter((tab) => !taken.has(tab));
      if (other.tab_ids.length === 0) delete groups[otherId];
    }
    if (group.tab_ids.length > 0) groups[id] = group; else delete groups[id];
    this.write(groups);
    return groups;
  }

  remove(id: string): void {
    const groups = this.read();
    if (!(id in groups)) return;
    delete groups[id];
    this.write(groups);
  }
}

export function isTabGroupsPath(pathname: string): boolean {
  return pathname === ROUTE || pathname.startsWith(`${ROUTE}/`);
}

export async function handleTabGroupsRequest(request: Request, pathname: string, store: TabGroupStore): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (pathname === ROUTE) {
    if (request.method !== "GET") return jsonResponse({ error: { code: "method_not_allowed", message: "GET only" } }, 405);
    return jsonResponse({ groups: store.read() }, 200, headers);
  }
  let id: string;
  try { id = decodeURIComponent(pathname.slice(ROUTE.length + 1)); } catch { return badRequest("invalid_id", "Malformed group id"); }
  if (!/^[A-Za-z0-9_-]+$/.test(id) || id.length > ID_MAX) return badRequest("invalid_id", "Group id must be 1-64 letters, digits, - or _");
  if (request.method === "DELETE") {
    store.remove(id);
    return jsonResponse({ ok: true }, 200, headers);
  }
  if (request.method !== "PUT") return jsonResponse({ error: { code: "method_not_allowed", message: "PUT or DELETE" } }, 405);
  let body: unknown;
  try { body = await request.json(); } catch { return badRequest("invalid_json", "Body must be JSON"); }
  const group = sanitizeGroup(body);
  if (!group) return badRequest("invalid_group", "A group needs machine_id, workspace_id, a name up to 80 characters and up to 200 tab_ids");
  const current = store.read();
  if (!(id in current) && Object.keys(current).length >= GROUPS_MAX) return badRequest("too_many", `At most ${GROUPS_MAX} groups`);
  const groups = store.set(id, group);
  return jsonResponse({ group: groups[id] ?? null }, 200, headers);
}
