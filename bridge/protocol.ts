/**
 * What travels through the chat repo. The phone app (app/app.js) reads the
 * same format, so change both together.
 *
 *  - An issue is one chat. Its body is the first message.
 *  - A comment without a marker, from an allowed user, is a message.
 *  - A comment the bridge writes starts with a marker line:
 *      <!-- minh {"kind":"reply","state":"working"} -->
 *    GitHub hides HTML comments when it renders, so the chat stays readable
 *    on github.com too.
 *  - Commands are messages: /stop, /approve <id>, /deny <id>.
 *  - Chat settings (provider, model, mode, tool approval) ride on an options
 *    line, from the phone: at the top of the issue body for a new chat, or
 *    as a comment of their own to change them mid-chat (no turn runs):
 *      <!-- minh-options {"provider":"gemini-web","model":"gemini-pro"} -->
 *  - The bridge publishes what can be picked in .minh/options.json.
 */

export type ReplyState = "working" | "done" | "error" | "stopped";
export type ApprovalState = "pending" | "approved" | "denied" | "expired";

export type Marker =
	| { kind: "reply"; state: ReplyState; part?: number }
	| {
			kind: "approval";
			approvalId: string;
			tool: string;
			state: ApprovalState;
	  }
	| { kind: "notice" };

const MARKER_PATTERN = /^<!-- minh (\{.*?\}) -->\r?\n?/;

export function withMarker(marker: Marker, text: string): string {
	return `<!-- minh ${JSON.stringify(marker)} -->\n${text}`;
}

export function readMarker(body: string | null | undefined): Marker | undefined {
	const match = MARKER_PATTERN.exec(body ?? "");
	if (!match) return undefined;
	try {
		return JSON.parse(match[1]) as Marker;
	} catch {
		return undefined;
	}
}

export function stripMarker(body: string): string {
	return body.replace(MARKER_PATTERN, "");
}

export interface ChatOptions {
	provider?: string;
	model?: string;
	mode?: "act" | "plan";
	autoApprove?: boolean;
}

const OPTIONS_PATTERN = /^<!-- minh-options (\{.*?\}) -->\r?\n?/;

export function withOptions(options: ChatOptions, text: string): string {
	return `<!-- minh-options ${JSON.stringify(options)} -->\n${text}`;
}

/** The options line at the top of a body, cleaned up; undefined when there is none. */
export function readOptions(body: string | null | undefined): ChatOptions | undefined {
	const match = OPTIONS_PATTERN.exec(body ?? "");
	if (!match) return undefined;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(match[1]);
	} catch {
		return undefined;
	}
	const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
	const options: ChatOptions = {};
	if (text(raw.provider)) options.provider = text(raw.provider);
	if (text(raw.model)) options.model = text(raw.model);
	if (raw.mode === "act" || raw.mode === "plan") options.mode = raw.mode;
	if (typeof raw.autoApprove === "boolean") options.autoApprove = raw.autoApprove;
	return options;
}

export function stripOptions(body: string): string {
	return body.replace(OPTIONS_PATTERN, "");
}

export type Command =
	| { name: "stop" }
	| { name: "approve" | "deny"; approvalId: string; reason?: string };

export function parseCommand(text: string): Command | undefined {
	const trimmed = text.trim();
	if (/^\/stop$/i.test(trimmed)) return { name: "stop" };
	const match = /^\/(approve|deny)\s+(\S+)(?:\s+([\s\S]+))?$/i.exec(trimmed);
	if (!match) return undefined;
	return {
		name: match[1].toLowerCase() as "approve" | "deny",
		approvalId: match[2],
		reason: match[3]?.trim() || undefined,
	};
}

/** GitHub rejects comments over 65536 characters; leave room for the marker. */
export const MAX_COMMENT_CHARS = 60_000;

export function chatTitle(text: string): string {
	const line = text.trim().split(/\r?\n/)[0] ?? "";
	return line.length > 60 ? `${line.slice(0, 57)}...` : line || "New chat";
}
