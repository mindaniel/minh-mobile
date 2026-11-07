/**
 * The few GitHub REST calls the bridge needs, with two habits that keep it
 * inside GitHub's limits while polling every few seconds:
 *  - reads send the last ETag, and a 304 does not count against the limit;
 *  - writes are counted, so streaming edits can back off before GitHub's
 *    secondary limit on content creation (about 500 an hour) kicks in.
 */

export interface Issue {
	number: number;
	title: string;
	body: string | null;
	state: "open" | "closed";
	user: { login: string };
	created_at: string;
	updated_at: string;
	pull_request?: unknown;
}

export interface Comment {
	id: number;
	body: string;
	user: { login: string };
	issue_url: string;
	created_at: string;
	updated_at: string;
}

export class RateLimitedError extends Error {
	constructor(readonly waitMs: number) {
		super(`GitHub rate limit, waiting ${Math.ceil(waitMs / 1000)}s`);
	}
}

export class GitHubError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const WRITE_WINDOW_MS = 60 * 60_000;
/** Below GitHub's ~500/hour so a phone writing too never gets blocked. */
const WRITES_PER_HOUR = 400;

export class GitHub {
	private readonly etags = new Map<string, { etag: string; data: unknown }>();
	private readonly writes: number[] = [];
	readonly apiBase: string;

	constructor(
		private readonly token: string,
		readonly repo: string,
		apiBase = "https://api.github.com",
	) {
		this.apiBase = apiBase.replace(/\/+$/, "");
	}

	private headers(extra?: Record<string, string>): Record<string, string> {
		return {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${this.token}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "minh-mobile-bridge",
			...extra,
		};
	}

	private async check(response: Response, what: string): Promise<void> {
		if (response.ok || response.status === 304) return;
		const remaining = response.headers.get("x-ratelimit-remaining");
		const retryAfter = Number(response.headers.get("retry-after"));
		if (response.status === 429 || (response.status === 403 && (remaining === "0" || retryAfter))) {
			const reset = Number(response.headers.get("x-ratelimit-reset"));
			const waitMs = retryAfter
				? retryAfter * 1000
				: reset
					? Math.max(1000, reset * 1000 - Date.now())
					: 60_000;
			throw new RateLimitedError(waitMs);
		}
		const text = await response.text().catch(() => "");
		let message = text;
		try {
			message = (JSON.parse(text) as { message?: string }).message ?? text;
		} catch {}
		throw new GitHubError(
			response.status,
			`${what} failed (${response.status}): ${message.slice(0, 300)}`,
		);
	}

	/** GET that returns undefined when nothing changed since the last call. */
	async getIfChanged<T>(path: string): Promise<T | undefined> {
		const cached = this.etags.get(path);
		const response = await fetch(`${this.apiBase}${path}`, {
			headers: this.headers(cached ? { "If-None-Match": cached.etag } : {}),
		});
		await this.check(response, `GET ${path}`);
		if (response.status === 304) return undefined;
		const data = (await response.json()) as T;
		const etag = response.headers.get("etag");
		if (etag) this.etags.set(path, { etag, data });
		return data;
	}

	async get<T>(path: string): Promise<T> {
		const response = await fetch(`${this.apiBase}${path}`, {
			headers: this.headers(),
		});
		await this.check(response, `GET ${path}`);
		return (await response.json()) as T;
	}

	async write<T>(
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<T> {
		this.writes.push(Date.now());
		const response = await fetch(`${this.apiBase}${path}`, {
			method,
			headers: this.headers({ "Content-Type": "application/json" }),
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		await this.check(response, `${method} ${path}`);
		const text = await response.text();
		return (text ? JSON.parse(text) : undefined) as T;
	}

	/** Writes made in the last hour, for pacing optional edits. */
	recentWrites(): number {
		const cutoff = Date.now() - WRITE_WINDOW_MS;
		while (this.writes.length && this.writes[0] < cutoff) this.writes.shift();
		return this.writes.length;
	}

	/** Seconds to wait between streaming edits, longer as the hour fills up. */
	editIntervalMs(): number {
		const used = this.recentWrites() / WRITES_PER_HOUR;
		if (used < 0.5) return 4_000;
		if (used < 0.8) return 10_000;
		return 30_000;
	}

	// ---- the calls -------------------------------------------------------

	whoAmI(): Promise<{ login: string }> {
		return this.get("/user");
	}

	getRepo(): Promise<{ private: boolean; permissions?: { push?: boolean } }> {
		return this.get(`/repos/${this.repo}`);
	}

	/** Open issues updated recently, newest first. */
	recentIssues(): Promise<Issue[] | undefined> {
		return this.getIfChanged(
			`/repos/${this.repo}/issues?state=open&sort=updated&direction=desc&per_page=50`,
		);
	}

	/** Comments across the repo updated since `since`, oldest first. */
	commentsSince(since: string): Promise<Comment[] | undefined> {
		return this.getIfChanged(
			`/repos/${this.repo}/issues/comments?since=${encodeURIComponent(since)}&sort=updated&direction=asc&per_page=100`,
		);
	}

	addComment(issue: number, body: string): Promise<Comment> {
		return this.write("POST", `/repos/${this.repo}/issues/${issue}/comments`, {
			body,
		});
	}

	editComment(id: number, body: string): Promise<Comment> {
		return this.write("PATCH", `/repos/${this.repo}/issues/comments/${id}`, {
			body,
		});
	}

	/** Raw text of a file, or undefined when it does not exist. */
	async readFile(path: string): Promise<{ text: string; sha: string } | undefined> {
		try {
			const file = await this.get<{ content: string; sha: string }>(
				`/repos/${this.repo}/contents/${path}`,
			);
			return {
				text: Buffer.from(file.content, "base64").toString("utf-8"),
				sha: file.sha,
			};
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return undefined;
			throw error;
		}
	}

	async writeFile(path: string, text: string, message: string): Promise<void> {
		const existing = await this.readFile(path);
		if (existing?.text === text) return;
		await this.write("PUT", `/repos/${this.repo}/contents/${path}`, {
			message,
			content: Buffer.from(text, "utf-8").toString("base64"),
			...(existing ? { sha: existing.sha } : {}),
		});
	}

	/** Files in a folder, or [] when it does not exist. */
	async listFolder(path: string): Promise<Array<{ name: string; path: string; sha: string }>> {
		try {
			const list = await this.getIfChanged<Array<{ name: string; path: string; sha: string; type: string }>>(
				`/repos/${this.repo}/contents/${path}`,
			);
			const files = list ?? (this.etags.get(`/repos/${this.repo}/contents/${path}`)?.data as typeof list) ?? [];
			return files.filter((file) => file.type === "file");
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) return [];
			throw error;
		}
	}

	async deleteFile(path: string, sha: string, message: string): Promise<void> {
		await this.write("DELETE", `/repos/${this.repo}/contents/${path}`, {
			message,
			sha,
		});
	}

	/** Accept pending invitations to `repo` (the server account was added as a collaborator). */
	async acceptInvitation(): Promise<boolean> {
		const invitations = await this.get<Array<{ id: number; repository: { full_name: string } }>>(
			"/user/repository_invitations",
		);
		const match = invitations.find(
			(invite) => invite.repository.full_name.toLowerCase() === this.repo.toLowerCase(),
		);
		if (!match) return false;
		await this.write("PATCH", `/user/repository_invitations/${match.id}`);
		return true;
	}
}

export function issueNumberFromUrl(url: string): number | undefined {
	const match = /\/issues\/(\d+)$/.exec(url);
	return match ? Number(match[1]) : undefined;
}
