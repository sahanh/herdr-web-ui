import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleSharedSettingsRequest, SharedSettingsStore } from "./shared-settings.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function store(): { store: SharedSettingsStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "shared-settings-"));
  dirs.push(dir);
  return { store: SharedSettingsStore.inStateDir(dir), dir };
}

const call = (s: SharedSettingsStore, method: string, body?: string) =>
  handleSharedSettingsRequest(new Request("http://app/api/mission-control/settings", { method, body }), s);

it("keeps no settings until some are saved, and a broken file reads as none", async () => {
  const { store: s, dir } = store();
  expect(await (await call(s, "GET")).json()).toEqual({ settings: null, updated: null });
  writeFileSync(join(dir, "settings.json"), "{not json");
  expect(s.read()).toEqual({ settings: null, updated: null });
});

it("saves the whole record, in a private file, and replaces it on the next save", async () => {
  const { store: s, dir } = store();
  const saved = await call(s, "PUT", JSON.stringify({ settings: { terminalFontSize: 14, theme: "dark" } }));
  expect(saved.status).toBe(200);
  expect(statSync(join(dir, "settings.json")).mode & 0o777).toBe(0o600);
  await call(s, "PUT", JSON.stringify({ settings: { terminalFontSize: 15 } }));
  const read = (await (await call(s, "GET")).json()) as { settings: unknown; updated: number };
  expect(read.settings).toEqual({ terminalFontSize: 15 });
  expect(typeof read.updated).toBe("number");
});

it("refuses a body that is not a settings object, or is too large", async () => {
  const { store: s } = store();
  expect((await call(s, "PUT", "nope")).status).toBe(400);
  expect((await call(s, "PUT", JSON.stringify({ settings: [1] }))).status).toBe(400);
  expect((await call(s, "PUT", JSON.stringify({ settings: { x: "a".repeat(70_000) } }))).status).toBe(400);
  expect((await call(s, "DELETE")).status).toBe(405);
  expect(s.read().settings).toBeNull();
});
