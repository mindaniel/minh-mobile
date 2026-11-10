/**
 * The loop: read the chat repo every few seconds, turn new issues and
 * comments into turns on minh sessions, and write the replies back.
 */

import { type BridgeConfig, readJson, statePath, writeJson } from "./config";
import { type Comment, GitHub, type Issue, issueNumberFromUrl, RateLimitedError } from "./github";
import { Hub, type HubEvent } from "./hub";
import {
	type ChatOptions,
	chatTitle,
	parseCommand,
	readMarker,
	readOptions,
	stripOptions,
	withMarker,
} from "./protocol";
import { Push } from "./push";
import { ReplyWriter, summarizeToolInput } from "./reply";

export interface BridgeState {
	/** Issues and comments older than this were there before the bridge. */
	startedAt: string;
	lastCommentId: number;
	commentsSince: string;
	/** Issue number -> its minh session. */
	chats: Record<string, ChatState>;
	/** Issues whose opening message has been sent. */
	openedIssues: number[];
}

interface ChatState {
	sessionId?: string;
	title?: string;
	/** What the phone picked for this chat. */
	options?: ChatOptions;
	/** provider|model|autoApprove the session runs with; a change starts a new one. */
	applied?: string;
	/** The issue is closed (archived or deleted) and its session let go. */
	closed?: boolean;
}

export const OPTIONS_FILE = ".minh/options.json";
const OPTIONS_REFRESH_MS = 10 * 60_000;

export function freshState(now = new Date()): BridgeState {
	return {
		startedAt: now.toISOString(),
		lastCommentId: 0,
		commentsSince: now.toISOString(),
		chats: {},
		openedIssues: [],
	};
}

const SINCE_BUCKET_MS = 10 * 60_000;
const SINCE_MARGIN_MS = 2 * 60_000;

/**
 * `since` for the comments query, held still for ten minutes at a time so the
 * URL (and so its ETag) stays the same and unchanged polls cost nothing.
 */
export function stableSince(nowMs: number): string {
	return new Date(Math.floor((nowMs - SINCE_MARGIN_MS) / SINCE_BUCKET_MS) * SINCE_BUCKET_MS).toISOString();
}

interface ActiveTurn {
	issue: number;
	reply: ReplyWriter;
}

interface PendingApproval {
	issue: number;
	commentId: number;
	tool: string;
	body: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Bridge {
	readonly github: GitHub;
	readonly hub: Hub;
	readonly push: Push;
	private state: BridgeState;
	private readonly queues = new Map<number, Promise<void>>();
	private readonly active = new Map<string, ActiveTurn>();
	private readonly approvals = new Map<string, PendingApproval>();
	private stopped = false;

	constructor(
		private readonly config: BridgeConfig,
		deps?: { github?: GitHub; hub?: Hub; push?: Push },
	) {
		this.github = deps?.github ?? new GitHub(config.token, config.repo, config.apiBase);
		this.hub = deps?.hub ?? new Hub(config);
		this.push = deps?.push ?? new Push(this.github, config.vapid);
		this.state = { ...freshState(), ...readJson<Partial<BridgeState>>(statePath(), {}) };
	}

	private save(): void {
		writeJson(statePath(), this.state);
	}

	private allowed(login: string | undefined): boolean {
		return !!login && this.config.allowedUsers.includes(login.toLowerCase());
	}

	async start(): Promise<void> {
		this.save();
		await this.push.publishKey().catch((error) =>
			console.warn("could not publish the push key:", (error as Error).message),
		);
		await this.hub.connect();
		this.hub.onEvent((event) => this.onHubEvent(event));
		await this.publishOptions();
		console.log(`minh-mobile: watching ${this.config.repo} (hub ${this.hub.hubUrl})`);
	}

	private optionsPublishedAt = 0;

	/** Lists the providers and models the phone can pick from (no keys). */
	async publishOptions(): Promise<void> {
		this.optionsPublishedAt = Date.now();
		try {
			const catalog = await this.hub.catalog();
			await this.github.writeFile(
				OPTIONS_FILE,
				`${JSON.stringify(catalog, null, 1)}\n`,
				"minh: models the phone can pick",
			);
		} catch (error) {
			console.warn("could not publish the model list:", (error as Error).message);
		}
	}

	async run(): Promise<void> {
		await this.start();
		while (!this.stopped) {
			try {
				if (Date.now() - this.optionsPublishedAt > OPTIONS_REFRESH_MS) await this.publishOptions();
				await this.tick();
			} catch (error) {
				if (error instanceof RateLimitedError) {
					console.warn(error.message);
					await sleep(error.waitMs);
					continue;
				}
				console.warn("poll failed:", (error as Error).message);
				await sleep(15_000);
			}
			await sleep(this.config.pollSeconds * 1000);
		}
	}

	stop(): void {
		this.stopped = true;
		this.hub.close();
	}

	/** One poll. Exposed for tests. */
	async tick(): Promise<void> {
		const issues = await this.github.recentIssues();
		if (issues) {
			for (const issue of [...issues].reverse()) this.onIssue(issue);
		}
		let since = this.state.commentsSince;
		for (;;) {
			const comments = await this.github.commentsSince(since);
			if (!comments) break;
			for (const comment of comments) this.onComment(comment);
			// A full page means more may be waiting (after a long stop): keep going.
			if (comments.length < 100) break;
			const last = comments[comments.length - 1].updated_at;
			if (last === since) break;
			since = last;
		}
		const next = stableSince(Date.now());
		if (next > this.state.commentsSince) this.state.commentsSince = next;
		this.save();
	}

	private onIssue(issue: Issue): void {
		if (issue.pull_request || !this.allowed(issue.user.login)) return;
		const known = this.state.chats[issue.number];
		if (issue.state === "closed") {
			// Archived or deleted on the phone: stop the run and let the session go.
			if (known && !known.closed) {
				known.closed = true;
				void this.release(issue.number).catch((error) =>
					console.warn(`issue #${issue.number}: could not stop its session:`, (error as Error).message),
				);
			}
			return;
		}
		// Restored: the next message brings the session back from its transcript.
		if (known?.closed) known.closed = false;
		if (this.state.openedIssues.includes(issue.number)) return;
		if (issue.created_at < this.state.startedAt) return;
		this.state.openedIssues.push(issue.number);
		const options = readOptions(issue.body);
		const text = stripOptions(issue.body ?? "").trim() || issue.title;
		this.state.chats[issue.number] = {
			...this.state.chats[issue.number],
			title: issue.title,
			...(options ? { options } : {}),
		};
		this.enqueue(issue.number, text);
	}

	private onComment(comment: Comment): void {
		if (comment.id <= this.state.lastCommentId) return;
		if (comment.created_at < this.state.startedAt) return;
		this.state.lastCommentId = comment.id;
		if (readMarker(comment.body) || !this.allowed(comment.user.login)) return;
		const issue = issueNumberFromUrl(comment.issue_url);
		if (issue === undefined) return;
		const options = readOptions(comment.body);
		if (options) {
			// Settings only: the next message runs with them.
			const chat = (this.state.chats[issue] ??= {});
			chat.options = { ...chat.options, ...options };
			return;
		}
		const command = parseCommand(comment.body);
		if (command) {
			void this.runCommand(issue, command).catch((error) =>
				console.warn(`issue #${issue}: ${command.name} failed:`, (error as Error).message),
			);
			return;
		}
		this.enqueue(issue, comment.body);
	}

	/** Turns in one chat run one after another; chats run side by side. */
	private enqueue(issue: number, text: string): void {
		const previous = this.queues.get(issue) ?? Promise.resolve();
		const next = previous
			.then(() => this.runTurn(issue, text))
			.catch((error) => console.warn(`issue #${issue}:`, (error as Error).message));
		this.queues.set(issue, next);
	}

	/** Resolves when every queued turn has finished. For tests. */
	async idle(): Promise<void> {
		for (;;) {
			const pending = [...this.queues.values()];
			await Promise.all(pending);
			const now = [...this.queues.values()];
			if (now.length === pending.length && now.every((p, i) => p === pending[i])) return;
		}
	}

	private async runTurn(issue: number, text: string): Promise<void> {
		const chat = (this.state.chats[issue] ??= {});
		const reply = new ReplyWriter(this.github, issue);
		await reply.start();
		let sessionId: string | undefined;
		try {
			const resolved = this.hub.resolve(chat.options);
			const key = `${resolved.provider}|${resolved.model}|${resolved.autoApprove}`;
			const title = chat.title || chatTitle(text);
			sessionId = chat.sessionId;
			if (sessionId && !(await this.hub.ensureLive(sessionId, chat.options))) sessionId = undefined;
			if (!sessionId) {
				sessionId = await this.hub.startSession(title, issue, chat.options);
			} else if ((chat.applied ?? key) !== key) {
				// Model or tool approval changed: same conversation, new session.
				sessionId = await this.hub.startSession(title, issue, chat.options, sessionId);
			}
			chat.sessionId = sessionId;
			chat.applied = key;
			this.save();
			this.active.set(sessionId, { issue, reply });
			const result = await this.hub.send(sessionId, text, resolved.mode);
			const state =
				result.finishReason === "aborted" ? "stopped" : result.error ? "error" : "done";
			await reply.finish(state, result.text, result.error);
			await this.notify(issue, chat.title, state === "error" ? `Failed: ${result.error}` : reply.replyText);
		} catch (error) {
			const message = (error as Error).message;
			await reply.finish("error", undefined, message);
			await this.notify(issue, chat.title, `Failed: ${message}`);
		} finally {
			if (sessionId) this.active.delete(sessionId);
			this.expireApprovals(issue);
		}
	}

	private async notify(issue: number, title: string | undefined, body: string): Promise<void> {
		await this.push
			.notify({ title: title || `Chat #${issue}`, body: body.trim() || "Done.", issue })
			.catch((error) => console.warn("push failed:", (error as Error).message));
	}

	private onHubEvent(event: HubEvent): void {
		const turn = this.active.get(event.sessionId);
		if (!turn) return;
		const payload = event.payload;
		switch (event.eventType) {
			case "runtime.chat.text_delta":
				if (typeof payload.text === "string") turn.reply.appendText(payload.text);
				return;
			case "runtime.chat.iteration_start":
				turn.reply.newStep();
				return;
			case "runtime.chat.tool_call_start":
				// The hub reports each tool twice; only the agent's copy has an id.
				if (typeof payload.toolCallId === "string" && typeof payload.toolName === "string") {
					turn.reply.tool(payload.toolName, payload.input);
				}
				return;
			case "approval.requested":
				void this.askApproval(turn.issue, payload).catch((error) =>
					console.warn("approval comment failed:", (error as Error).message),
				);
				return;
		}
	}

	private async askApproval(issue: number, payload: Record<string, unknown>): Promise<void> {
		const approvalId = String(payload.approvalId ?? "");
		if (!approvalId) return;
		const tool = String(payload.toolName ?? "tool");
		let input = typeof payload.inputJson === "string" ? payload.inputJson : JSON.stringify(payload.input ?? null);
		try {
			input = JSON.stringify(JSON.parse(input), null, 2);
		} catch {}
		if (input.length > 3000) input = `${input.slice(0, 3000)}\n…`;
		const body = `**${tool}** wants to run:\n\n\`\`\`json\n${input}\n\`\`\`\n\nReply \`/approve ${approvalId}\` or \`/deny ${approvalId}\`.`;
		const comment = await this.github.addComment(
			issue,
			withMarker({ kind: "approval", approvalId, tool, state: "pending" }, body),
		);
		this.approvals.set(approvalId, { issue, commentId: comment.id, tool, body });
		await this.notify(issue, this.state.chats[issue]?.title, `Approval needed: ${tool} ${summarizeToolInput(payload.inputJson)}`);
	}

	private async settleApproval(approvalId: string, state: "approved" | "denied" | "expired"): Promise<void> {
		const pending = this.approvals.get(approvalId);
		if (!pending) return;
		this.approvals.delete(approvalId);
		await this.github
			.editComment(
				pending.commentId,
				withMarker({ kind: "approval", approvalId, tool: pending.tool, state }, pending.body),
			)
			.catch(() => undefined);
	}

	private expireApprovals(issue: number): void {
		for (const [approvalId, pending] of this.approvals) {
			if (pending.issue === issue) void this.settleApproval(approvalId, "expired");
		}
	}

	private async release(issue: number): Promise<void> {
		const sessionId = this.state.chats[issue]?.sessionId;
		if (!sessionId) return;
		if (this.active.has(sessionId)) await this.hub.abort(sessionId);
		await this.hub.release(sessionId);
	}

	private async runCommand(
		issue: number,
		command: NonNullable<ReturnType<typeof parseCommand>>,
	): Promise<void> {
		if (command.name === "stop") {
			const sessionId = this.state.chats[issue]?.sessionId;
			if (sessionId && this.active.has(sessionId)) await this.hub.abort(sessionId);
			return;
		}
		const approved = command.name === "approve";
		if (!this.approvals.has(command.approvalId)) return;
		await this.hub.respondApproval(
			command.approvalId,
			approved,
			command.reason ?? (approved ? "Approved on the phone." : "Denied on the phone."),
		);
		await this.settleApproval(command.approvalId, approved ? "approved" : "denied");
	}
}
