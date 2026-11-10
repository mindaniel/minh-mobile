/**
 * Folders the phone can pick for a chat to work in: the bridge's default,
 * the ones in config.json, and the ones minh sessions on this account ran in
 * lately (terminal and phone alike), newest first.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** Where minh keeps session manifests (the same rule as @cline/shared's resolveSessionDataDir). */
export function sessionDataDir(): string {
	const explicit = process.env.CLINE_SESSION_DATA_DIR?.trim();
	if (explicit) return explicit;
	const data = process.env.CLINE_DATA_DIR?.trim() || join(homedir(), ".cline", "data");
	return join(data, "sessions");
}

export function isFolder(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Temp and system folders: test runs and stray sessions, not places to work. */
export function noiseRoots(): string[] {
	return [tmpdir(), process.env.TEMP, process.env.SystemRoot, process.env.windir]
		.filter((root): root is string => !!root)
		.map((root) => resolve(root).toLowerCase());
}

function isNoise(path: string, roots: string[]): boolean {
	const lower = path.toLowerCase();
	return roots.some((root) => lower === root || lower.startsWith(`${root}${sep}`)) || /[\\/]\.[^\\/]+$/.test(path);
}

/** Workspace folders of the most recent sessions, newest first, existing only. */
export function recentFolders(
	sessionsDir = sessionDataDir(),
	limit = 15,
	skip: string[] = noiseRoots(),
	scan = 300,
): string[] {
	let entries: Array<{ id: string; time: number }>;
	try {
		entries = readdirSync(sessionsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => {
				try {
					return { id: entry.name, time: statSync(join(sessionsDir, entry.name)).mtimeMs };
				} catch {
					return { id: entry.name, time: 0 };
				}
			});
	} catch {
		return [];
	}
	entries.sort((a, b) => b.time - a.time);
	const found: string[] = [];
	const seen = new Set<string>();
	for (const { id } of entries.slice(0, scan)) {
		const manifest = join(sessionsDir, id, `${id}.json`);
		if (!existsSync(manifest)) continue;
		let folder: unknown;
		try {
			const data = JSON.parse(readFileSync(manifest, "utf-8"));
			folder = data.workspace_root || data.cwd;
		} catch {
			continue;
		}
		if (typeof folder !== "string" || !folder.trim()) continue;
		const path = resolve(folder);
		const key = process.platform === "win32" ? path.toLowerCase() : path;
		if (seen.has(key)) continue;
		seen.add(key);
		if (isNoise(path, skip) || !isFolder(path)) continue;
		found.push(path);
		if (found.length >= limit) break;
	}
	return found;
}

/** Default first, then config's list, then recent ones; no repeats. */
export function folderChoices(defaultFolder: string, configured: string[] = [], recent: string[] = []): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const folder of [defaultFolder, ...configured, ...recent]) {
		if (!folder?.trim()) continue;
		const path = resolve(folder);
		const key = process.platform === "win32" ? path.toLowerCase() : path;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(path);
	}
	return out;
}
