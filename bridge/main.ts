#!/usr/bin/env bun
/**
 * bun run setup    one-time questions, writes ~/.minh-mobile/config.json
 * bun run bridge   runs the bridge (keep it open, like minh)
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Bridge, freshState } from "./bridge";
import {
	type BridgeConfig,
	bridgeHome,
	configPath,
	loadConfig,
	readJson,
	statePath,
	writeJson,
} from "./config";
import { GitHub, GitHubError } from "./github";
import { generateVapid } from "./push";

function ask(question: string, fallback?: string): string {
	const answer = prompt(fallback ? `${question} [${fallback}]` : question)?.trim();
	return answer || fallback || "";
}

async function setup(): Promise<void> {
	const previous = readJson<Partial<BridgeConfig>>(configPath(), {});
	console.log(`Settings go in ${bridgeHome()} (only your Windows account can read them).\n`);

	const repo = ask("Chat repo (owner/name, private)", previous.repo);
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" is not owner/name.`);
	console.log(
		"\nToken for the bridge, from the account the bridge posts as:\n" +
			`  - the repo owner's own account: a fine-grained token for ${repo} only, Issues + Contents read/write;\n` +
			"  - a second account added as collaborator: a classic token with the repo scope\n" +
			"    (fine-grained tokens cannot reach repos the account only collaborates on).\n" +
			"(github.com > Settings > Developer settings)",
	);
	const token = ask("Token", previous.token ? "keep current" : undefined);
	const finalToken = token === "keep current" ? previous.token! : token;
	if (!finalToken) throw new Error("A token is needed.");

	const github = new GitHub(finalToken, repo, previous.apiBase);
	const me = await github.whoAmI();
	console.log(`Token belongs to ${me.login}.`);
	try {
		await github.getRepo();
	} catch (error) {
		if (!(error instanceof GitHubError) || error.status !== 404) throw error;
		if (await github.acceptInvitation()) {
			console.log(`Accepted the invitation to ${repo}.`);
		} else {
			throw new Error(
				`${me.login} cannot see ${repo}. Add ${me.login} as a collaborator on it (Settings > Collaborators), then run setup again.`,
			);
		}
	}

	const owner = repo.split("/")[0];
	const allowed = ask(
		"GitHub users allowed to chat (comma separated)",
		previous.allowedUsers?.join(",") || owner,
	)
		.split(",")
		.map((user) => user.trim())
		.filter(Boolean);

	const guessClinemin = resolve(import.meta.dir, "..", "..", "clinemin");
	const clinemin = resolve(
		ask("clinemin folder", previous.clinemin || (existsSync(guessClinemin) ? guessClinemin : undefined)),
	);
	if (!existsSync(join(clinemin, "sdk", "packages", "core"))) {
		throw new Error(`${clinemin} does not look like a clinemin checkout.`);
	}
	const cwd = resolve(ask("Folder new chats work in", previous.cwd || homedir()));
	const autoApprove = ask(
		"Let the agent run tools without asking? (y = like minh's auto mode, n = approve each on the phone)",
		previous.autoApproveTools === false ? "n" : "y",
	);

	const config: BridgeConfig = {
		...previous,
		repo,
		token: finalToken,
		allowedUsers: allowed,
		clinemin,
		cwd,
		autoApproveTools: !/^n/i.test(autoApprove),
		pollSeconds: previous.pollSeconds ?? 3,
		vapid: previous.vapid ?? generateVapid(`https://github.com/${me.login}`),
	};
	writeJson(configPath(), config);
	if (!existsSync(statePath())) writeJson(statePath(), freshState());
	console.log(`\nSaved ${configPath()}. Start the bridge with: bun run bridge`);
}

async function main(): Promise<void> {
	if (process.argv[2] === "setup") {
		await setup();
		return;
	}
	const bridge = new Bridge(loadConfig());
	process.on("SIGINT", () => {
		bridge.stop();
		process.exit(0);
	});
	await bridge.run();
}

main().catch((error) => {
	console.error((error as Error).message);
	process.exit(1);
});
