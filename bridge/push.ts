/**
 * Phone notifications without a server of our own: the phone app saves its
 * push subscription as a file in the chat repo (.minh/push/<device>.json),
 * and the bridge posts straight to Google's or Apple's push service.
 */

import webpush from "web-push";
import type { BridgeConfig } from "./config";
import type { GitHub } from "./github";

export const PUSH_FOLDER = ".minh/push";
export const VAPID_KEY_FILE = ".minh/vapid-public-key.txt";

const REFRESH_MS = 60_000;

export function generateVapid(subject: string): NonNullable<BridgeConfig["vapid"]> {
	const keys = webpush.generateVAPIDKeys();
	return { ...keys, subject };
}

interface StoredSubscription {
	path: string;
	sha: string;
	subscription: webpush.PushSubscription;
}

export class Push {
	private subscriptions: StoredSubscription[] = [];
	private loadedAt = 0;

	constructor(
		private readonly github: GitHub,
		private readonly vapid: BridgeConfig["vapid"],
	) {}

	/** Tells the phone app which key to subscribe with. */
	async publishKey(): Promise<void> {
		if (!this.vapid) return;
		await this.github.writeFile(
			VAPID_KEY_FILE,
			this.vapid.publicKey,
			"minh: push notification key",
		);
	}

	private async refresh(): Promise<void> {
		if (Date.now() - this.loadedAt < REFRESH_MS) return;
		this.loadedAt = Date.now();
		const files = await this.github.listFolder(PUSH_FOLDER);
		const known = new Map(this.subscriptions.map((entry) => [entry.path, entry]));
		const next: StoredSubscription[] = [];
		for (const file of files.filter((entry) => entry.name.endsWith(".json"))) {
			const cached = known.get(file.path);
			if (cached?.sha === file.sha) {
				next.push(cached);
				continue;
			}
			const content = await this.github.readFile(file.path);
			if (!content) continue;
			try {
				next.push({
					path: file.path,
					sha: content.sha,
					subscription: JSON.parse(content.text) as webpush.PushSubscription,
				});
			} catch {
				console.warn(`push: ${file.path} is not valid JSON, skipped`);
			}
		}
		this.subscriptions = next;
	}

	async notify(message: { title: string; body: string; issue: number }): Promise<void> {
		if (!this.vapid) return;
		try {
			await this.refresh();
		} catch (error) {
			console.warn("push: could not read subscriptions:", (error as Error).message);
		}
		const payload = JSON.stringify({
			title: message.title,
			body: message.body.length > 180 ? `${message.body.slice(0, 177)}...` : message.body,
			issue: message.issue,
		});
		await Promise.all(
			this.subscriptions.map(async (entry) => {
				try {
					await webpush.sendNotification(entry.subscription, payload, {
						vapidDetails: this.vapid,
						TTL: 24 * 60 * 60,
					});
				} catch (error) {
					const status = (error as { statusCode?: number }).statusCode;
					if (status === 404 || status === 410) {
						// The phone unsubscribed or reinstalled: forget it.
						this.subscriptions = this.subscriptions.filter((other) => other !== entry);
						await this.github
							.deleteFile(entry.path, entry.sha, "minh: remove expired push subscription")
							.catch(() => undefined);
						return;
					}
					console.warn(`push to ${entry.path} failed:`, (error as Error).message);
				}
			}),
		);
	}
}
