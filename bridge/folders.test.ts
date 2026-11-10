import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderChoices, recentFolders } from "./folders";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "minh-folders-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function session(id: string, folder: string, ageSeconds: number) {
	const dir = join(root, "sessions", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${id}.json`), JSON.stringify({ session_id: id, workspace_root: folder }));
	const time = Date.now() / 1000 - ageSeconds;
	utimesSync(dir, time, time);
}

test("recent folders: newest first, no repeats, only ones that still exist", () => {
	const a = join(root, "a");
	const b = join(root, "b");
	mkdirSync(a);
	mkdirSync(b);
	session("s1", a, 300);
	session("s2", b, 200);
	session("s3", a, 100);
	session("s4", join(root, "gone"), 50);
	expect(recentFolders(join(root, "sessions"), 15, [])).toEqual([a, b]);
	expect(recentFolders(join(root, "missing"), 15, [])).toEqual([]);
	// Temp and system folders are left out.
	expect(recentFolders(join(root, "sessions"), 15, [root.toLowerCase()])).toEqual([]);
});

test("folder choices: default, then configured, then recent", () => {
	const list = folderChoices(join(root, "home"), [join(root, "fav")], [join(root, "fav"), join(root, "recent")]);
	expect(list).toEqual([join(root, "home"), join(root, "fav"), join(root, "recent")]);
});
