import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleMissionControlRequest, MissionControlStore } from "./mission-control.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function store(): { store: MissionControlStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mission-control-"));
  dirs.push(dir);
  return { store: MissionControlStore.inStateDir(dir), dir };
}

const route = "/api/mission-control/tiers";
const call = (s: MissionControlStore, method: string, path: string, body?: unknown) =>
  handleMissionControlRequest(new Request(`http://app${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), path, s);

it("keeps no picks until one is made, and a broken file reads as none", () => {
  const { store: s, dir } = store();
  expect(s.read()).toEqual({});
  writeFileSync(join(dir, "mission-control.json"), "{not json");
  expect(s.read()).toEqual({});
});

it("sets, moves and removes one session at a time, in a private file", async () => {
  const { store: s, dir } = store();
  const id = "m1/w2/w2:t7";
  const set = await call(s, "PUT", `${route}/${encodeURIComponent(id)}`, { tier: "focus", label: "cost opti" });
  expect(set.status).toBe(200);
  expect(s.read()[id]).toMatchObject({ tier: "focus", label: "cost opti" });
  expect(statSync(join(dir, "mission-control.json")).mode & 0o777).toBe(0o600);

  const first = s.read()[id]!.since;
  await call(s, "PUT", `${route}/${encodeURIComponent(id)}`, { tier: "focus", label: "renamed" });
  expect(s.read()[id]).toEqual({ tier: "focus", label: "renamed", since: first });

  await call(s, "PUT", `${route}/other`, { tier: "watch", label: "monitor" });
  const listed = await (await call(s, "GET", route)).json() as { tiers: Record<string, unknown> };
  expect(Object.keys(listed.tiers).sort()).toEqual([id, "other"].sort());

  expect((await call(s, "DELETE", `${route}/${encodeURIComponent(id)}`)).status).toBe(200);
  expect(Object.keys(s.read())).toEqual(["other"]);
  expect(JSON.parse(readFileSync(join(dir, "mission-control.json"), "utf8")).tiers.other.tier).toBe("watch");
});

it("refuses picks it cannot keep", async () => {
  const { store: s } = store();
  expect((await call(s, "PUT", `${route}/x`, { tier: "sessions", label: "a" })).status).toBe(400);
  expect((await call(s, "PUT", `${route}/x`, { tier: "focus" })).status).toBe(400);
  expect((await call(s, "PUT", `${route}/x`, { tier: "focus", label: "a".repeat(201) })).status).toBe(400);
  expect((await call(s, "PUT", `${route}/${"a".repeat(257)}`, { tier: "focus", label: "a" })).status).toBe(400);
  expect((await call(s, "PUT", `${route}/%E0%A4%A`, { tier: "focus", label: "a" })).status).toBe(400);
  expect((await call(s, "POST", route)).status).toBe(405);
  expect(s.read()).toEqual({});
});
