/**
 * One agent reply, written into a GitHub comment as it grows. Edits are
 * spaced out (GitHub limits how fast content can change), serialized, and
 * split over several comments when the reply outgrows one.
 */

import type { GitHub } from "./github";
import { MAX_COMMENT_CHARS, type ReplyState, withMarker } from "./protocol";

const TOOL_INPUT_KEYS = [
	"command",
	"commands",
	"path",
	"paths",
	"file_path",
	"filePath",
	"files",
	"query",
	"queries",
	"url",
	"urls",
	"pattern",
	"regex",
];

function shortValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && value.length > 0) {
		const first = shortValue(value[0]);
		if (first === undefined) return undefined;
		return value.length > 1 ? `${first} (+${value.length - 1} more)` : first;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const key = TOOL_INPUT_KEYS.find((candidate) => shortValue(record[candidate]) !== undefined);
		return key ? shortValue(record[key]) : undefined;
	}
	return undefined;
}

export function summarizeToolInput(input: unknown): string {
	if (input == null) return "";
	let value: unknown = input;
	if (typeof input === "string") {
		try {
			value = JSON.parse(input);
		} catch {
			value = input;
		}
	}
	let text = shortValue(value) ?? JSON.stringify(value);
	text = text.replace(/\s+/g, " ").trim();
	return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

export class ReplyWriter {
	private text = "";
	private readonly tools: string[] = [];
	private commentId?: number;
	/** Characters of `text` already finished in earlier comments. */
	private offset = 0;
	private part = 1;
	private lastEditAt = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private writing: Promise<unknown> = Promise.resolve();
	private finished = false;

	constructor(
		private readonly github: GitHub,
		private readonly issue: number,
	) {}

	async start(): Promise<void> {
		const comment = await this.github.addComment(
			this.issue,
			withMarker({ kind: "reply", state: "working" }, "_Working…_"),
		);
		this.commentId = comment.id;
		this.lastEditAt = Date.now();
	}

	get replyText(): string {
		return this.text;
	}

	appendText(delta: string): void {
		if (!delta || this.finished) return;
		this.text += delta;
		this.schedule();
	}

	/** A new model step: keep its text apart from the last one's. */
	newStep(): void {
		if (this.text && !this.text.endsWith("\n\n")) {
			this.text += this.text.endsWith("\n") ? "\n" : "\n\n";
		}
	}

	tool(name: string, input: unknown): void {
		if (this.finished) return;
		const summary = summarizeToolInput(input);
		this.tools.push(summary ? `\`${name}\` ${summary.replace(/`/g, "'")}` : `\`${name}\``);
		this.schedule();
	}

	private render(state: ReplyState): string {
		const own = this.text.slice(this.offset);
		const placeholder =
			state === "working" ? "_Working…_" : state === "stopped" ? "_Stopped._" : "";
		let body = own.trim() ? own : placeholder;
		if (this.tools.length > 0) {
			const steps = this.tools.slice(-40).map((line) => `- ${line}`);
			if (this.tools.length > 40) steps.unshift(`- … ${this.tools.length - 40} earlier`);
			body += `\n\n<details><summary>${this.tools.length} step${this.tools.length === 1 ? "" : "s"}</summary>\n\n${steps.join("\n")}\n\n</details>`;
		}
		return withMarker(
			{ kind: "reply", state, ...(this.part > 1 ? { part: this.part } : {}) },
			body,
		);
	}

	private schedule(): void {
		if (this.timer || this.finished) return;
		const wait = Math.max(0, this.lastEditAt + this.github.editIntervalMs() - Date.now());
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush("working");
		}, wait);
	}

	private flush(state: ReplyState): Promise<unknown> {
		this.writing = this.writing
			.then(() => this.write(state))
			.catch((error) => console.warn(`issue #${this.issue}: reply edit failed:`, (error as Error).message));
		return this.writing;
	}

	private async write(state: ReplyState): Promise<void> {
		if (this.commentId === undefined) return;
		// Move whole comments' worth of text out first.
		while (this.text.length - this.offset > MAX_COMMENT_CHARS) {
			let cut = this.text.lastIndexOf("\n", this.offset + MAX_COMMENT_CHARS);
			if (cut <= this.offset) cut = this.offset + MAX_COMMENT_CHARS;
			await this.github.editComment(
				this.commentId,
				withMarker(
					{ kind: "reply", state: "done", ...(this.part > 1 ? { part: this.part } : {}) },
					this.text.slice(this.offset, cut),
				),
			);
			this.offset = cut;
			this.part += 1;
			const next = await this.github.addComment(this.issue, this.render(state));
			this.commentId = next.id;
		}
		await this.github.editComment(this.commentId, this.render(state));
		this.lastEditAt = Date.now();
	}

	async finish(state: Exclude<ReplyState, "working">, fallbackText?: string, error?: string): Promise<void> {
		if (this.finished) return;
		this.finished = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (!this.text.trim() && fallbackText?.trim()) this.text = fallbackText;
		if (error) this.text += `${this.text ? "\n\n" : ""}**Error:** ${error}`;
		await this.flush(state);
	}
}
