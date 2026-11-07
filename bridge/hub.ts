/**
 * Talks to the minh hub the same way `minh dashboard` and the Telegram
 * connector do. The SDK is loaded from the clinemin checkout at runtime, so
 * this project never changes clinemin and always matches the minh you run.
 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as CoreSdk from "@cline/core";
import type * as SharedSdk from "@cline/shared";
import type { BridgeConfig } from "./config";

type Core = typeof CoreSdk;
type Shared = typeof SharedSdk;
type SessionClient = InstanceType<Core["HubSessionClient"]>;
type StartRequest = Parameters<SessionClient["startRuntimeSession"]>[0];

export interface HubEvent {
	sessionId: string;
	eventType: string;
	payload: Record<string, unknown>;
}

export interface TurnResult {
	text: string;
	finishReason?: string;
	error?: string;
}

/**
 * From source, the way minh runs (`bun --conditions=development`): the built
 * core cannot start a hub daemon, since it looks for a dist/entry.js the
 * build does not produce, and source is never stale after a `git pull`.
 */
async function loadSdk(clinemin: string): Promise<{ core: Core; shared: Shared }> {
	const corePath = join(clinemin, "sdk", "packages", "core", "src", "index.ts");
	const sharedPath = join(clinemin, "sdk", "packages", "shared", "src", "index.ts");
	if (!existsSync(corePath) || !existsSync(sharedPath)) {
		throw new Error(`${clinemin} does not look like a clinemin checkout.`);
	}
	if (!process.execArgv.some((arg) => arg.includes("conditions=development"))) {
		console.warn('Start the bridge with "bun run bridge" (it needs --conditions=development, like minh).');
	}
	const core = (await import(pathToFileURL(corePath).href)) as Core;
	const shared = (await import(pathToFileURL(sharedPath).href)) as Shared;
	return { core, shared };
}

export class Hub {
	private client!: SessionClient;
	private sdk!: { core: Core; shared: Shared };
	private readonly listeners = new Set<(event: HubEvent) => void>();
	private unsubscribe?: () => void;
	hubUrl = "";

	constructor(private readonly config: BridgeConfig) {}

	async connect(): Promise<void> {
		this.sdk = await loadSdk(this.config.clinemin);
		const hub = await this.sdk.core.ensureDetachedHubServer(this.config.cwd);
		this.hubUrl = hub.url;
		this.client = new this.sdk.core.HubSessionClient({
			address: hub.url,
			authToken: hub.authToken,
			clientType: "minh-mobile",
			displayName: "minh mobile (GitHub)",
			workspaceRoot: this.config.cwd,
			cwd: this.config.cwd,
		});
		await this.client.connect();
		this.unsubscribe = this.client.streamEvents(
			{},
			{
				onEvent: (event) => {
					for (const listener of this.listeners) listener(event);
				},
				onError: (error) => console.warn("hub event stream:", error.message),
			},
		);
	}

	close(): void {
		this.unsubscribe?.();
		this.client?.close();
	}

	onEvent(listener: (event: HubEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async startRequest(): Promise<StartRequest> {
		const { core, shared } = this.sdk;
		const settings = new core.ProviderSettingsManager().getLastUsedProviderSettings({
			isClinePassEnabled: true,
		});
		const provider = this.config.provider || settings?.provider;
		const model = this.config.model || settings?.model;
		if (!provider || !model) {
			throw new Error(
				'No provider/model yet. Chat once in minh on this account, or set "provider" and "model" in config.json.',
			);
		}
		const cwd = this.config.cwd;
		// The same prompt minh builds for a terminal session (apps/cli/src/runtime/prompt.ts).
		const systemPrompt = shared.buildClineSystemPrompt({
			ide: "Terminal Shell",
			workspaceRoot: cwd,
			workspaceName: basename(cwd),
			metadata: await core.buildWorkspaceMetadata(cwd),
			rules: core.mergeRulesForSystemPrompt(undefined, undefined),
			providerId: provider,
			prompts: core.getWebProviderPrompts(provider),
			platform: process.platform,
		});
		return {
			workspaceRoot: cwd,
			cwd,
			provider,
			model,
			mode: "act",
			// No key: the hub uses the one minh saved for this provider. Must be
			// undefined, not "": the hub falls back with `??`.
			apiKey: undefined,
			systemPrompt,
			enableTools: true,
			enableSpawn: true,
			enableTeams: true,
			autoApproveTools: this.config.autoApproveTools,
			source: "minh-mobile",
			interactive: true,
		} as StartRequest;
	}

	async startSession(title: string, issue: number): Promise<string> {
		const request = await this.startRequest();
		const started = await this.client.startRuntimeSession(request);
		await this.client
			.updateSession({
				sessionId: started.sessionId,
				metadata: { title, transport: "github", githubIssue: issue, repo: this.config.repo },
			})
			.catch(() => undefined);
		return started.sessionId;
	}

	/**
	 * Make sure the session can take a turn: running in the hub already, or
	 * started back up from its transcript (after a hub or bridge restart).
	 * Returns false when it no longer exists.
	 */
	async ensureLive(sessionId: string): Promise<boolean> {
		const row = (await this.client.listSessions({ limit: 500 })).find(
			(candidate) => candidate.sessionId === sessionId,
		);
		if (!row) return false;
		if (row.live) return true;
		if (row.heldByPid) {
			throw new Error(
				`this chat is open in a minh window (pid ${row.heldByPid}). Close it there first.`,
			);
		}
		const request = await this.startRequest();
		const meta = row.metadata ?? {};
		const provider = typeof meta.provider === "string" ? meta.provider : request.provider;
		await this.client.startRuntimeSession(
			{
				...request,
				provider,
				model: typeof meta.model === "string" ? meta.model : request.model,
			},
			{ sessionId, initialMessages: await this.client.readMessages(sessionId) },
		);
		return true;
	}

	/** Runs one turn and resolves when it ends. Progress arrives through onEvent. */
	async send(sessionId: string, prompt: string): Promise<TurnResult> {
		const reply = await this.client.sendSessionInput(
			sessionId,
			{ prompt, mode: "act" },
			{ timeoutMs: null },
		);
		const result = reply.result as
			| { text?: string; finishReason?: string; error?: unknown }
			| undefined;
		return {
			text: typeof result?.text === "string" ? result.text : "",
			finishReason: result?.finishReason,
			error:
				result?.finishReason === "error"
					? String(result.text || "The run failed.")
					: undefined,
		};
	}

	abort(sessionId: string): Promise<unknown> {
		return this.client.abortRuntimeSession(sessionId);
	}

	respondApproval(approvalId: string, approved: boolean, reason?: string): Promise<void> {
		return this.client.respondToolApproval({ approvalId, approved, reason });
	}
}
