/**
 * Keeps the bridge's secrets (GitHub token, push key) out of config.json as
 * plain text. On Windows they are sealed with DPAPI for the current Windows
 * account: the file holds "dpapi:<base64>", which nobody else, and no other
 * machine, can open. An agent that reads the file (it runs as you, and minh's
 * tools can read any file) sees only that blob.
 *
 * This stops a secret leaking by accident, the way a chat that lists your
 * home folder sends what it reads to the model's provider. It does not stop
 * a program running as you that sets out to unseal it.
 */

import { spawnSync } from "node:child_process";

const PREFIX = "dpapi:";

export const canSeal = process.platform === "win32";

export const isSealed = (value: string | undefined): boolean => !!value?.startsWith(PREFIX);

// The secret travels over stdin, never the command line (other programs can read command lines).
function powershell(script: string, input: string): string {
	const result = spawnSync(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-Command", `Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd(); ${script}`],
		{ input, encoding: "utf-8", windowsHide: true },
	);
	if (result.status !== 0) {
		throw new Error(`Windows could not ${script.includes("Unprotect") ? "unseal" : "seal"} a secret: ${(result.stderr || "").trim().split("\n")[0]}`);
	}
	return result.stdout.trim();
}

/** Seal a secret for this Windows account; elsewhere it is kept as is. */
export function seal(secret: string): string {
	if (!canSeal || !secret || isSealed(secret)) return secret;
	return (
		PREFIX +
		powershell(
			"[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($in), $null, 'CurrentUser'))",
			secret,
		)
	);
}

export function unseal(value: string): string {
	if (!isSealed(value)) return value;
	if (!canSeal) throw new Error("This secret was sealed on Windows and can only be opened there.");
	return powershell(
		"[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in.Trim()), $null, 'CurrentUser'))",
		value.slice(PREFIX.length),
	);
}
