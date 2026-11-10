/**
 * Talks to the minh hub the same way `minh dashboard` and the Telegram
 * connector do. The SDK is loaded from the clinemin checkout at runtime, so
 * this project never changes clinemin and always matches the minh you run.
 */

import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import type * as CoreSdk from "@cline/core";
import type * as SharedSdk from "@cline/shared";
import type { BridgeConfig } from "./config";
import { folderChoices, isFolder, recentFolders } from "./folders";
import type { ChatOptions } from "./protocol";

export interface ResolvedOptions {
	provider: string;
	model: string;
	mode: "act" | "plan";
	autoApprove: boolean;
	cwd: string;
}

/** Published to .minh/options.json for the phone's model picker. */
export interface OptionsCatalog {
	defaults?: ResolvedOptions;
	/** Folders to offer: the default, config.json's, then recently used ones. */
	folders: string[];
	providers: Array<{
		id: string;
		name: string;
		/** The model minh last used with this provider. */
		model?: string;
		models: Array<{ id: string; name: string }>;
	}>;
}

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

	/**
	 * What a chat runs with: its own picks first, then config.json, then the
	 * provider/model minh used last. A provider picked without a model gets
	 * the model minh last used with it.
	 */
	resolve(options: ChatOptions = {}): ResolvedOptions {
		const manager = new this.sdk.core.ProviderSettingsManager();
		const last = manager.getLastUsedProviderSettings({ isClinePassEnabled: true });
		const provider = options.provider || this.config.provider || last?.provider;
		let model = options.model;
		if (!model && provider) {
			model =
				provider === (this.config.provider || last?.provider)
					? this.config.model || last?.model
					: manager.getProviderSettings(provider)?.model;
		}
		if (!provider || !model) {
			throw new Error(
				options.provider
					? `No model picked for ${options.provider}. Pick one in the app.`
					: 'No provider/model yet. Chat once in minh on this account, or set "provider" and "model" in config.json.',
			);
		}
		// "my-project" means a folder inside the default one.
		const cwd = resolvePath(this.config.cwd, options.cwd || ".");
		if (!isFolder(cwd)) {
			if (!options.createFolder) {
				throw new Error(`Folder not found on the server: ${cwd}. Pick "Create it if missing" to make it.`);
			}
			mkdirSync(cwd, { recursive: true });
			console.log(`made folder ${cwd}`);
		}
		return {
			provider,
			model,
			mode: options.mode ?? "act",
			autoApprove: options.autoApprove ?? this.config.autoApproveTools,
			cwd,
		};
	}

	/**
	 * What the phone can pick from: the providers set up in minh on this
	 * account, with their models. Never includes keys.
	 */
	async catalog(): Promise<OptionsCatalog> {
		const { core } = this.sdk;
		const manager = new core.ProviderSettingsManager();
		const { providers } = await core.listLocalProviders(manager, { isClinePassEnabled: true });
		let defaults: ResolvedOptions | undefined;
		try {
			defaults = this.resolve();
		} catch {}
		return {
			defaults,
			folders: folderChoices(this.config.cwd, this.config.folders, recentFolders()),
			providers: providers
				.filter((provider) => provider.enabled || provider.id === defaults?.provider)
				.map((provider) => ({
					id: provider.id,
					name: provider.name,
					model: manager.getProviderSettings(provider.id)?.model || provider.defaultModelId,
					models: (provider.modelList ?? [])
						.slice(0, 300)
						.map((model) => ({ id: model.id, name: model.name || model.id })),
				})),
		};
	}

	private async startRequest(options?: ChatOptions): Promise<StartRequest> {
		const { core, shared } = this.sdk;
		const { provider, model, mode, autoApprove, cwd } = this.resolve(options);
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
			mode,
			// No key: the hub uses the one minh saved for this provider. Must be
			// undefined, not "": the hub falls back with `??`.
			apiKey: undefined,
			systemPrompt,
			enableTools: true,
			enableSpawn: true,
			enableTeams: true,
			autoApproveTools: autoApprove,
			source: "minh-mobile",
			interactive: true,
		} as StartRequest;
	}

	/**
	 * A new session for a chat. With `from`, it carries that session's
	 * conversation over (used to switch model or tool approval mid-chat; the
	 * old session is let go).
	 */
	async startSession(
		title: string,
		issue: number,
		options?: ChatOptions,
		from?: string,
	): Promise<string> {
		const request = await this.startRequest(options);
		let resume: { initialMessages: Awaited<ReturnType<SessionClient["readMessages"]>> } | undefined;
		if (from) {
			resume = { initialMessages: await this.client.readMessages(from) };
			await this.client.stopRuntimeSession(from).catch(() => undefined);
		}
		const started = await this.client.startRuntimeSession(
			request,
			resume as Parameters<SessionClient["startRuntimeSession"]>[1],
		);
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
	async ensureLive(sessionId: string, options?: ChatOptions): Promise<boolean> {
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
		// Back up with what the chat picked, or else what the session last ran with.
		const meta = row.metadata ?? {};
		const fallback: ChatOptions = {
			provider: typeof meta.provider === "string" ? meta.provider : undefined,
			model: typeof meta.model === "string" ? meta.model : undefined,
		};
		const request = await this.startRequest(options?.provider ? options : { ...options, ...fallback });
		await this.client.startRuntimeSession(request, {
			sessionId,
			initialMessages: await this.client.readMessages(sessionId),
		});
		return true;
	}

	/** Runs one turn and resolves when it ends. Progress arrives through onEvent. */
	async send(sessionId: string, prompt: string, mode: "act" | "plan" = "act"): Promise<TurnResult> {
		const reply = await this.client.sendSessionInput(
			sessionId,
			{ prompt, mode },
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

	/** Stop running a session; its transcript stays, so it can come back. */
	async release(sessionId: string): Promise<void> {
		await this.client.stopRuntimeSession(sessionId).catch(() => undefined);
	}

	abort(sessionId: string): Promise<unknown> {
		return this.client.abortRuntimeSession(sessionId);
	}

	respondApproval(approvalId: string, approved: boolean, reason?: string): Promise<void> {
		return this.client.respondToolApproval({ approvalId, approved, reason });
	}
}
