/**
 * Tab groups (fork only; the contract is in shared/tab-groups.ts). One copy of the server's groups
 * for the whole page, read when the first strip mounts, when the window comes back and every
 * POLL_MS while a strip shows, so a group made on another device turns up. Writes go through at
 * once and show before the server answers; a failed write reads the server's groups again.
 */
import { useEffect, useSyncExternalStore } from "react";

import type { TabGroup, TabGroupsResponse } from "../../shared/tab-groups.ts";
import { ApiError } from "./api.ts";

const ROUTE = "/api/mission-control/tab-groups";
const POLL_MS = 20_000;

export type TabGroups = Record<string, TabGroup>;

let groups: TabGroups = {};
let users = 0;
let reading: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const publish = (next: TabGroups): void => { groups = next; for (const listener of listeners) listener(); };

async function failure(response: Response): Promise<ApiError> {
  let code: string | null = null, detail = response.statusText;
  try { ({ code, message: detail } = ((await response.json()) as { error: { code: string; message: string } }).error); } catch {}
  return new ApiError(ROUTE, response.status, detail, code);
}

/** a write made while a read was out wins: the read's answer is dropped when a write followed it */
let writes = 0;
export function refreshTabGroups(): Promise<void> {
  if (reading) return reading;
  const startedAt = writes;
  reading = (async () => {
    try {
      const response = await fetch(ROUTE, { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as TabGroupsResponse;
      if (writes === startedAt) publish(body.groups ?? {});
    } catch {} finally { reading = null; }
  })();
  return reading;
}

const onFocus = (): void => { void refreshTabGroups(); };

/** a fresh id, for a group about to be saved */
export function newTabGroupId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Saves a group whole; the server takes its tabs out of the PC's other groups, as this copy does. */
export async function saveTabGroup(id: string, group: TabGroup): Promise<void> {
  writes += 1;
  const next: TabGroups = {};
  const taken = new Set(group.tab_ids);
  for (const [otherId, other] of Object.entries(groups)) {
    if (otherId === id) continue;
    const tabIds = other.machine_id === group.machine_id ? other.tab_ids.filter((tab) => !taken.has(tab)) : other.tab_ids;
    if (tabIds.length > 0) next[otherId] = { ...other, tab_ids: tabIds };
  }
  if (group.tab_ids.length > 0) next[id] = group;
  publish(next);
  const response = await fetch(`${ROUTE}/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(group) });
  if (!response.ok) { const error = await failure(response); void refreshTabGroups(); throw error; }
}

export async function removeTabGroup(id: string): Promise<void> {
  if (!(id in groups)) return;
  writes += 1;
  const next = { ...groups };
  delete next[id];
  publish(next);
  const response = await fetch(`${ROUTE}/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) { const error = await failure(response); void refreshTabGroups(); throw error; }
}

const subscribe = (listener: () => void): (() => void) => { listeners.add(listener); return () => listeners.delete(listener); };

/** Every group the server keeps; reading starts with the first caller and stops with the last. */
export function useTabGroups(): TabGroups {
  useEffect(() => {
    users += 1;
    if (users === 1) {
      void refreshTabGroups();
      timer = setInterval(() => { if (document.visibilityState === "visible") void refreshTabGroups(); }, POLL_MS);
      window.addEventListener("focus", onFocus);
    }
    return () => {
      users -= 1;
      if (users > 0) return;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return useSyncExternalStore(subscribe, () => groups);
}

/**
 * A tab asked for from a group's +: the New tab dialog takes it when it opens (takeGroupJoin)
 * and hands the pane it made back (joinGroupWhenReady); the strip adds that pane's tab to the
 * group once the snapshot shows it. Nothing else opens the dialog with a group in hand.
 */
export interface GroupJoin { machineId: string; groupId: string }
let asked: GroupJoin | null = null;
const ready: Array<GroupJoin & { paneId: string; at: number }> = [];
const JOIN_TTL_MS = 120_000;

export function askGroupJoin(join: GroupJoin): void { asked = join; }
export function takeGroupJoin(): GroupJoin | null { const join = asked; asked = null; return join; }
export function joinGroupWhenReady(join: GroupJoin, paneId: string): void {
  ready.push({ ...join, paneId, at: Date.now() });
  for (const listener of listeners) listener();
}

/** the joins waiting on this PC, oldest first; a join older than JOIN_TTL_MS is dropped */
export function pendingGroupJoins(machineId: string): ReadonlyArray<GroupJoin & { paneId: string }> {
  const now = Date.now();
  for (let index = ready.length - 1; index >= 0; index -= 1) if (now - ready[index]!.at > JOIN_TTL_MS) ready.splice(index, 1);
  return ready.filter((join) => join.machineId === machineId);
}
export function settleGroupJoin(paneId: string): void {
  const index = ready.findIndex((join) => join.paneId === paneId);
  if (index >= 0) ready.splice(index, 1);
}
