import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleTabGroupsRequest, TabGroupStore } from "./tab-groups.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function store(): { store: TabGroupStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tab-groups-"));
  dirs.push(dir);
  return { store: TabGroupStore.inStateDir(dir), dir };
}

const route = "/api/mission-control/tab-groups";
const call = (s: TabGroupStore, method: string, path: string, body?: unknown) =>
  handleTabGroupsRequest(new Request(`http://app${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), path, s);
const group = (tabs: string[], name = "feature", machine = "local") => ({ machine_id: machine, workspace_id: "w1", name, tab_ids: tabs });

it("keeps no groups until one is made, and a broken file reads as none", async () => {
  const { store: s, dir } = store();
  expect(await (await call(s, "GET", route)).json()).toEqual({ groups: {} });
  writeFileSync(join(dir, "tab-groups.json"), "{not json");
  expect(s.read()).toEqual({});
});

it("saves, renames and removes a group, in a private file", async () => {
  const { store: s, dir } = store();
  const saved = await call(s, "PUT", `${route}/g1`, group(["w1:t1", "w1:t2"], "  tab groups "));
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ group: group(["w1:t1", "w1:t2"], "tab groups") });
  expect(statSync(join(dir, "tab-groups.json")).mode & 0o777).toBe(0o600);
  await call(s, "PUT", `${route}/g1`, group(["w1:t1", "w1:t2"], "renamed"));
  expect(s.read()["g1"]?.name).toBe("renamed");
  await call(s, "DELETE", `${route}/g1`);
  expect(s.read()).toEqual({});
});

it("keeps a tab in one group, and a group whose last tab left is gone", async () => {
  const { store: s } = store();
  await call(s, "PUT", `${route}/a`, group(["t1", "t2"]));
  await call(s, "PUT", `${route}/b`, group(["t3"]));
  await call(s, "PUT", `${route}/other-pc`, group(["t1"], "same id elsewhere", "devbox"));
  await call(s, "PUT", `${route}/b`, group(["t3", "t1"]));
  expect(s.read()["a"]?.tab_ids).toEqual(["t2"]);
  expect(s.read()["other-pc"]?.tab_ids).toEqual(["t1"]);
  await call(s, "PUT", `${route}/b`, group(["t3", "t1", "t2"]));
  expect(s.read()["a"]).toBeUndefined();
  const emptied = await call(s, "PUT", `${route}/b`, group([]));
  expect(await emptied.json()).toEqual({ group: null });
  expect(Object.keys(s.read())).toEqual(["other-pc"]);
});

it("refuses a malformed id or group", async () => {
  const { store: s } = store();
  expect((await call(s, "PUT", `${route}/a%2Fb`, group(["t1"]))).status).toBe(400);
  expect((await call(s, "PUT", `${route}/g`, { ...group(["t1"]), name: "  " })).status).toBe(400);
  expect((await call(s, "PUT", `${route}/g`, { ...group(["t1"]), tab_ids: [1] })).status).toBe(400);
  expect((await call(s, "POST", `${route}/g`, group(["t1"]))).status).toBe(405);
  expect(s.read()).toEqual({});
});
