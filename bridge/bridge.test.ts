import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeGitHub } from "../dev/fake-github";
import { Bridge, stableSince } from "./bridge";
import type { BridgeConfig } from "./config";
import { GitHub } from "./github";
import type { Hub, HubEvent, TurnResult } from "./hub";
import { parseCommand, readMarker, withMarker } from "./protocol";
import { Push } from "./push";

/** Stands in for the minh hub: replies by echoing, and can be told to stream or ask. */
class FakeHub {
	listeners = new Set<(event: HubEvent) => void>();
	sessions = new Map<string, string[]>();
	approvals = new Map<string, (approved: boolean) => void>();
	aborts = new Map<string, () => void>();
	script?: (sessionId: string, prompt: string) => Promise<TurnResult>;
	hubUrl = "fake";
	async connect() {}
	close() {}
	onEvent(listener: (event: HubEvent) => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emit(sessionId: string, eventType: string, payload: Record<string, unknown>) {
		for (const listener of this.listeners) listener({ sessionId, eventType, payload });
	}
	async startSession() {
		const id = `s${this.sessions.size + 1}`;
		this.sessions.set(id, []);
		return id;
	}
	async ensureLive(id: string) {
		return this.sessions.has(id);
	}
	async send(sessionId: string, prompt: string): Promise<TurnResult> {
		this.sessions.get(sessionId)!.push(prompt);
		if (this.script) return this.script(sessionId, prompt);
		this.emit(sessionId, "runtime.chat.text_delta", { text: `echo: ${prompt}` });
		return { text: `echo: ${prompt}`, finishReason: "completed" };
	}
	async abort(sessionId: string) {
		this.aborts.get(sessionId)?.();
	}
	async respondApproval(id: string, approved: boolean) {
		this.approvals.get(id)?.(approved);
	}
}

let home: string;
let fake: ReturnType<typeof createFakeGitHub>;
let hub: FakeHub;
let bridge: Bridge;
let you: GitHub;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "minh-mobile-"));
	process.env.MINH_MOBILE_HOME = home;
	fake = createFakeGitHub({ port: 0 });
	hub = new FakeHub();
	const config: BridgeConfig = {
		repo: fake.repo,
		token: "bot",
		allowedUsers: ["you"],
		clinemin: "",
		cwd: home,
		autoApproveTools: true,
		pollSeconds: 3,
		apiBase: fake.url,
	};
	const github = new GitHub("bot", fake.repo, fake.url);
	bridge = new Bridge(config, {
		github,
		hub: hub as unknown as Hub,
		push: new Push(github, undefined),
	});
	you = new GitHub("you", fake.repo, fake.url);
});

afterEach(() => {
	fake.server.stop(true);
	rmSync(home, { recursive: true, force: true });
});

const bodies = () => fake.comments.map((c) => ({ by: c.user.login, marker: readMarker(c.body), body: c.body }));

async function poll() {
	await bridge.tick();
	await bridge.idle();
}

describe("bridge", () => {
	test("a new issue starts a session and gets a reply", async () => {
		await bridge.start();
		await you.write("POST", `/repos/${fake.repo}/issues`, { title: "hello", body: "hello there" });
		await poll();
		const replies = bodies();
		expect(replies).toHaveLength(1);
		expect(replies[0].by).toBe("bot");
		expect(replies[0].marker).toEqual({ kind: "reply", state: "done" });
		expect(replies[0].body).toContain("echo: hello there");
	});

	test("follow-up comments go to the same session, in order", async () => {
		await bridge.start();
		await you.write("POST", `/repos/${fake.repo}/issues`, { title: "a", body: "one" });
		await poll();
		await you.addComment(1, "two");
		await you.addComment(1, "three");
		await poll();
		expect(hub.sessions.get("s1")).toEqual(["one", "two", "three"]);
		expect(hub.sessions.size).toBe(1);
	});

	test("ignores strangers and its own comments", async () => {
		await bridge.start();
		const stranger = new GitHub("stranger", fake.repo, fake.url);
		await stranger.write("POST", `/repos/${fake.repo}/issues`, { title: "x", body: "let me in" });
		await poll();
		await stranger.addComment(1, "please");
		await poll();
		expect(hub.sessions.size).toBe(0);
		expect(fake.comments.filter((c) => c.user.login === "bot")).toHaveLength(0);
	});

	test("streams text into the reply, then marks it done", async () => {
		await bridge.start();
		let release!: () => void;
		hub.script = async (sessionId) => {
			hub.emit(sessionId, "runtime.chat.text_delta", { text: "Looking" });
			hub.emit(sessionId, "runtime.chat.tool_call_start", { toolCallId: "t1", toolName: "read_files", input: { path: "a.ts" } });
			hub.emit(sessionId, "runtime.chat.tool_call_start", { toolName: "read_files" }); // the duplicate without an id
			hub.emit(sessionId, "runtime.chat.iteration_start", {});
			hub.emit(sessionId, "runtime.chat.text_delta", { text: "Done." });
			await new Promise<void>((resolve) => (release = resolve));
			return { text: "Done.", finishReason: "completed" };
		};
		await you.write("POST", `/repos/${fake.repo}/issues`, { title: "a", body: "go" });
		await bridge.tick();
		await Bun.sleep(50);
		expect(readMarker(fake.comments[0].body)).toEqual({ kind: "reply", state: "working" });
		release();
		await bridge.idle();
		const body = fake.comments[0].body;
		expect(readMarker(body)).toEqual({ kind: "reply", state: "done" });
		expect(body).toContain("Looking\n\nDone.");
		expect(body).toContain("1 step");
		expect(body).toContain("`read_files` a.ts");
	});

	test("/stop aborts the running turn", async () => {
		await bridge.start();
		hub.script = (sessionId) =>
			new Promise((resolve) => hub.aborts.set(sessionId, () => resolve({ text: "", finishReason: "aborted" })));
		await you.write("POST", `/repos/${fake.repo}/issues`, { title: "a", body: "long job" });
		await bridge.tick();
		await Bun.sleep(50);
		await you.addComment(1, "/stop");
		await poll();
		const reply = fake.comments.find((c) => c.user.login === "bot")!;
		expect(readMarker(reply.body)).toEqual({ kind: "reply", state: "stopped" });
	});

	test("approval: asks in a comment, /approve answers the hub", async () => {
		await bridge.start();
		let answer: boolean | undefined;
		hub.script = (sessionId) =>
			new Promise((resolve) => {
				hub.approvals.set("ap1", (approved) => {
					answer = approved;
					resolve({ text: "ran it", finishReason: "completed" });
				});
				hub.emit(sessionId, "approval.requested", {
					approvalId: "ap1",
					toolName: "run_commands",
					inputJson: JSON.stringify({ command: "rm -rf build" }),
				});
			});
		await you.write("POST", `/repos/${fake.repo}/issues`, { title: "a", body: "clean" });
		await bridge.tick();
		await Bun.sleep(100);
		const ask = fake.comments.find((c) => readMarker(c.body)?.kind === "approval")!;
		expect(readMarker(ask.body)).toMatchObject({ approvalId: "ap1", state: "pending", tool: "run_commands" });
		expect(ask.body).toContain("rm -rf build");
		await you.addComment(1, "/approve ap1");
		await poll();
		expect(answer).toBe(true);
		expect(readMarker(fake.comments.find((c) => c.id === ask.id)!.body)).toMatchObject({ state: "approved" });
	});

	test("restarts pick up where they left off without replaying", async () => {
		await bridge.start();
		await you.write("POST", `/repos/${fake.repo}/issues`, { title: "a", body: "one" });
		await poll();
		const github = new GitHub("bot", fake.repo, fake.url);
		const again = new Bridge(
			{ repo: fake.repo, token: "bot", allowedUsers: ["you"], clinemin: "", cwd: home, autoApproveTools: true, pollSeconds: 3, apiBase: fake.url },
			{ github, hub: hub as unknown as Hub, push: new Push(github, undefined) },
		);
		await again.start();
		await again.tick();
		await again.idle();
		expect(hub.sessions.get("s1")).toEqual(["one"]);
		await you.addComment(1, "two");
		await again.tick();
		await again.idle();
		expect(hub.sessions.get("s1")).toEqual(["one", "two"]);
	});
});

describe("protocol", () => {
	test("markers round-trip and commands parse", () => {
		const body = withMarker({ kind: "reply", state: "done" }, "hi");
		expect(readMarker(body)).toEqual({ kind: "reply", state: "done" });
		expect(readMarker("hi")).toBeUndefined();
		expect(parseCommand("/stop")).toEqual({ name: "stop" });
		expect(parseCommand("/approve ap_1")).toEqual({ name: "approve", approvalId: "ap_1", reason: undefined });
		expect(parseCommand("/deny ap_1 too risky")).toEqual({ name: "deny", approvalId: "ap_1", reason: "too risky" });
		expect(parseCommand("please /stop")).toBeUndefined();
	});

	test("since stays put for ten minutes", () => {
		const t = Date.parse("2026-11-07T10:13:00Z");
		expect(stableSince(t)).toBe("2026-11-07T10:10:00.000Z");
		expect(stableSince(t + 60_000)).toBe("2026-11-07T10:10:00.000Z");
		expect(stableSince(t - 4 * 60_000)).toBe("2026-11-07T10:00:00.000Z");
	});
});
