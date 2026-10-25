import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleRecentRequest, RecentStore } from "./mission-control-recent.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function store(): { store: RecentStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mission-control-recent-"));
  dirs.push(dir);
  return { store: RecentStore.inStateDir(dir), dir };
}

const route = "/api/mission-control/recent";
const call = (s: RecentStore, method: string, path: string) => handleRecentRequest(new Request(`http://app${path}`, { method }), path, s);

it("keeps nothing until a tab is opened, and a broken file reads as nothing", () => {
  const { store: s, dir } = store();
  expect(s.read()).toEqual({});
  writeFileSync(join(dir, "mission-control-recent.json"), "{not json");
  expect(s.read()).toEqual({});
});

it("stamps each tab under its box, in a private file", async () => {
  const { store: s, dir } = store();
  const res = await call(s, "PUT", `${route}/${encodeURIComponent("m1/w2/w2:t7")}`);
  expect(res.status).toBe(200);
  await call(s, "PUT", `${route}/local/w1/w1:t1`);
  const listed = await (await call(s, "GET", route)).json() as { recent: Record<string, Record<string, number>> };
  expect(Object.keys(listed.recent).sort()).toEqual(["local", "m1"]);
  expect(Object.keys(listed.recent.m1!)).toEqual(["w2/w2:t7"]);
  expect(statSync(join(dir, "mission-control-recent.json")).mode & 0o777).toBe(0o600);
});

it("keeps each box's most recent tabs without touching another box's", () => {
  const { store: s } = store();
  s.stamp("other", "w/t", 1);
  for (let i = 0; i < 205; i++) s.stamp("busy", `w/t${i}`, 1000 + i);
  const recent = s.read();
  expect(Object.keys(recent.busy!)).toHaveLength(200);
  expect(recent.busy!["w/t0"]).toBeUndefined();
  expect(recent.busy!["w/t204"]).toBe(1204);
  expect(recent.other).toEqual({ "w/t": 1 });
});

it("refuses ids it cannot keep", async () => {
  const { store: s } = store();
  expect((await call(s, "PUT", `${route}/nobox`)).status).toBe(400);
  expect((await call(s, "PUT", `${route}/${encodeURIComponent("/w/t")}`)).status).toBe(400);
  expect((await call(s, "PUT", `${route}/${"a".repeat(255)}/w/t`)).status).toBe(400);
  expect((await call(s, "PUT", `${route}/%E0%A4%A`)).status).toBe(400);
  expect((await call(s, "POST", route)).status).toBe(405);
  expect((await call(s, "DELETE", `${route}/m/w/t`)).status).toBe(405);
  expect(s.read()).toEqual({});
});
