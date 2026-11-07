// minh phone app. Talks only to GitHub: each chat is an issue in your private
// chat repo, each message a comment. The bridge on the server answers.
// Comment format: see bridge/protocol.ts.

const $ = (id) => document.getElementById(id);
const STORE_KEY = "minh-mobile";
const CHAT_POLL_MS = 3000;
const LIST_POLL_MS = 15000;
const MARKER = /^<!-- minh (\{.*?\}) -->\r?\n?/;

// ---------- settings ----------

function loadSettings() {
	try {
		return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
	} catch {
		return {};
	}
}
function saveSettings(next) {
	settings = { ...settings, ...next };
	try {
		localStorage.setItem(STORE_KEY, JSON.stringify(settings));
	} catch {}
}
let settings = loadSettings();
if (!settings.deviceId) saveSettings({ deviceId: crypto.randomUUID().slice(0, 8) });

// ---------- GitHub ----------

const etags = new Map();

class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

async function gh(path, { method = "GET", body, accept, conditional = false } = {}) {
	const base = (settings.apiBase || "https://api.github.com").replace(/\/+$/, "");
	const headers = {
		Accept: accept || "application/vnd.github.full+json",
		Authorization: `Bearer ${settings.token}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const cached = conditional ? etags.get(path) : undefined;
	if (cached) headers["If-None-Match"] = cached.etag;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await fetch(base + path, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		cache: "no-store",
	});
	if (response.status === 304 && cached) return { data: cached.data, changed: false };
	if (!response.ok) {
		let message = `${response.status}`;
		try {
			message = (await response.json()).message || message;
		} catch {}
		if (response.status === 401) message = "GitHub rejected the token.";
		if (response.status === 404) message = "Repo not found, or the token cannot see it.";
		if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
			message = "GitHub rate limit reached. Try again in a few minutes.";
		}
		throw new HttpError(response.status, message);
	}
	const text = await response.text();
	const data = text ? (accept === "application/vnd.github.raw" ? text : JSON.parse(text)) : undefined;
	const etag = response.headers.get("etag");
	if (conditional && etag) etags.set(path, { etag, data });
	return { data, changed: true };
}

const repoPath = (rest = "") => `/repos/${settings.repo}${rest}`;

// ---------- protocol ----------

function readMarker(body) {
	const match = MARKER.exec(body || "");
	if (!match) return undefined;
	try {
		return JSON.parse(match[1]);
	} catch {
		return undefined;
	}
}
function chatTitle(text) {
	const line = text.trim().split(/\r?\n/)[0] || "";
	return line.length > 60 ? `${line.slice(0, 57)}...` : line || "New chat";
}
const isCommand = (text) => /^\/(stop|approve|deny)\b/i.test(text.trim());

// ---------- state ----------

let chats = [];
let current = null; // { number, title, issue, comments }
let pending = []; // messages posted but not yet seen in the comment list
let chatTimer = 0;
let listTimer = 0;

// ---------- helpers ----------

function escapeHtml(text) {
	return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}
function relativeTime(iso) {
	const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d ago`;
	return new Date(iso).toLocaleDateString();
}
let toastTimer = 0;
function toast(text) {
	const el = $("toast");
	el.textContent = text;
	el.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => (el.hidden = true), 3500);
}
function nearBottom() {
	const el = $("scroller");
	return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}
function scrollToBottom() {
	const el = $("scroller");
	el.scrollTop = el.scrollHeight;
}

// ---------- setup ----------

$("setup-form").addEventListener("submit", async (event) => {
	event.preventDefault();
	const form = new FormData(event.target);
	const repo = String(form.get("repo")).trim().replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
	const token = String(form.get("token")).trim();
	const apiBase = String(form.get("apiBase") || "").trim();
	const error = $("setup-error");
	error.hidden = true;
	const button = event.target.querySelector("button[type=submit]");
	button.disabled = true;
	const previous = settings;
	settings = { ...settings, repo, token, apiBase };
	try {
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Repo should look like your-name/minh-chat.");
		const user = (await gh("/user")).data;
		await gh(repoPath());
		saveSettings({ repo, token, apiBase, login: user.login });
		start();
	} catch (err) {
		settings = previous;
		error.textContent = err.message;
		error.hidden = false;
	} finally {
		button.disabled = false;
	}
});

$("signout-btn").addEventListener("click", () => {
	if (!confirm("Remove the token from this phone?")) return;
	saveSettings({ token: "", login: "" });
	location.reload();
});

// ---------- drawer ----------

function openDrawer(open) {
	$("drawer").classList.toggle("open", open);
	$("scrim").hidden = !open;
}
$("menu-btn").addEventListener("click", () => openDrawer(true));
$("scrim").addEventListener("click", () => openDrawer(false));
$("new-btn").addEventListener("click", () => newChat());
$("drawer-new").addEventListener("click", () => newChat());

function renderChatList() {
	const list = $("chat-list");
	if (!chats.length) {
		list.innerHTML = `<p class="none">No chats yet.</p>`;
		return;
	}
	list.innerHTML = chats
		.map(
			(chat) =>
				`<button class="chat-item${current?.number === chat.number ? " active" : ""}" data-n="${chat.number}">${escapeHtml(chat.title)}<small>${relativeTime(chat.updated_at)}</small></button>`,
		)
		.join("");
}
$("chat-list").addEventListener("click", (event) => {
	const item = event.target.closest("[data-n]");
	if (!item) return;
	openDrawer(false);
	openChat(Number(item.dataset.n));
});

async function refreshList() {
	try {
		const { data, changed } = await gh(repoPath("/issues?state=open&sort=updated&direction=desc&per_page=50"), {
			conditional: true,
		});
		if (!changed && chats.length) return;
		chats = (data || []).filter((issue) => !issue.pull_request);
		renderChatList();
	} catch (err) {
		$("status-line").textContent = err.message;
	}
}

// ---------- chat ----------

function newChat() {
	openDrawer(false);
	current = null;
	pending = [];
	clearTimeout(chatTimer);
	history.replaceState(null, "", location.pathname);
	$("chat-title").textContent = "minh";
	$("messages").innerHTML = "";
	$("empty").hidden = false;
	updateComposer();
	renderChatList();
	$("input").focus();
}

async function openChat(number) {
	clearTimeout(chatTimer);
	pending = [];
	const known = chats.find((chat) => chat.number === number);
	current = { number, title: known?.title || `#${number}`, issue: known, comments: [] };
	history.replaceState(null, "", `?chat=${number}`);
	$("chat-title").textContent = current.title;
	$("messages").innerHTML = "";
	$("empty").hidden = true;
	renderChatList();
	updateComposer();
	await refreshChat(true);
}

async function fetchAllComments(number) {
	const all = [];
	let changedAny = false;
	for (let page = 1; page < 30; page += 1) {
		const { data, changed } = await gh(repoPath(`/issues/${number}/comments?per_page=100&page=${page}`), {
			conditional: true,
		});
		changedAny ||= changed;
		all.push(...(data || []));
		if (!data || data.length < 100) break;
	}
	return { comments: all, changed: changedAny };
}

async function refreshChat(force = false) {
	clearTimeout(chatTimer);
	if (!current) return;
	const number = current.number;
	try {
		if (!current.issue || force) {
			current.issue = (await gh(repoPath(`/issues/${number}`), { conditional: true })).data;
			current.title = current.issue.title;
			$("chat-title").textContent = current.title;
		}
		const { comments, changed } = await fetchAllComments(number);
		if (current?.number !== number) return;
		if (changed || force) {
			current.comments = comments;
			const seen = new Set(comments.map((c) => c.body.trim()));
			pending = pending.filter((text) => !seen.has(text.trim()));
			renderMessages();
		}
		$("status-line").textContent = "";
	} catch (err) {
		$("status-line").textContent = err.message;
	}
	if (current?.number === number && document.visibilityState === "visible") {
		chatTimer = setTimeout(() => refreshChat(), CHAT_POLL_MS);
	}
}

function lastReply() {
	if (!current) return undefined;
	for (let i = current.comments.length - 1; i >= 0; i -= 1) {
		const marker = readMarker(current.comments[i].body);
		if (marker?.kind === "reply") return marker;
	}
	return undefined;
}

function renderMessages() {
	const stick = nearBottom();
	const parts = [];
	if (current.issue) {
		parts.push(`<div class="msg-user">${escapeHtml(current.issue.body?.trim() || current.issue.title)}</div>`);
	}
	for (const comment of current.comments) {
		const marker = readMarker(comment.body);
		if (!marker) {
			if (isCommand(comment.body)) {
				const text = comment.body.trim().split(/\s+/)[0].slice(1);
				parts.push(`<div class="msg-note">${text === "stop" ? "Stopped by you" : text === "approve" ? "You approved" : "You denied"}</div>`);
			} else {
				parts.push(`<div class="msg-user">${escapeHtml(comment.body)}</div>`);
			}
			continue;
		}
		const html = comment.body_html || `<p>${escapeHtml(comment.body.replace(MARKER, ""))}</p>`;
		if (marker.kind === "reply") {
			const working = marker.state === "working";
			parts.push(
				`<div class="msg-bot${marker.state === "error" ? " error" : ""}">${html}${working ? `<div class="working"><i></i><i></i><i></i></div>` : ""}</div>`,
			);
		} else if (marker.kind === "approval") {
			const actions =
				marker.state === "pending"
					? `<div class="actions"><button class="approve" data-approve="${escapeHtml(marker.approvalId)}">Approve</button><button class="deny" data-deny="${escapeHtml(marker.approvalId)}">Deny</button></div>`
					: `<div class="result ${marker.state}">${{ approved: "Approved", denied: "Denied", expired: "No longer waiting" }[marker.state] || marker.state}</div>`;
			parts.push(`<div class="approval"><div class="msg-bot">${html}</div>${actions}</div>`);
		} else {
			parts.push(`<div class="msg-bot">${html}</div>`);
		}
	}
	for (const text of pending) parts.push(`<div class="msg-user sending">${escapeHtml(text)}</div>`);
	const last = current.comments[current.comments.length - 1];
	if (pending.length || (last && !readMarker(last.body) && !isCommand(last.body)) || (!current.comments.length && current.issue)) {
		parts.push(`<div class="msg-bot"><div class="working"><i></i><i></i><i></i></div></div>`);
	}
	$("messages").innerHTML = parts.join("");
	// The bridge's "Working…" placeholder: the dots already say it.
	for (const p of $("messages").querySelectorAll(".msg-bot > p:first-child")) {
		if (/^_?Working…_?$/.test(p.textContent.trim())) p.remove();
	}
	// Approval text tells the user to type a command; the buttons do it.
	for (const p of $("messages").querySelectorAll(".approval p:last-child")) {
		if (/\/approve/.test(p.textContent)) p.remove();
	}
	updateComposer();
	if (stick) scrollToBottom();
}

$("messages").addEventListener("click", async (event) => {
	const approve = event.target.closest("[data-approve]");
	const deny = event.target.closest("[data-deny]");
	if (!approve && !deny) return;
	const id = approve ? approve.dataset.approve : deny.dataset.deny;
	event.target.closest(".actions").innerHTML = `<div class="result">Sending…</div>`;
	await postComment(`/${approve ? "approve" : "deny"} ${id}`, { quiet: true });
});

// ---------- composer ----------

const input = $("input");
function autosize() {
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`;
}
function updateComposer() {
	const hasText = input.value.trim().length > 0;
	const working = current && lastReply()?.state === "working";
	$("send-btn").disabled = !hasText;
	$("stop-btn").hidden = !working || hasText;
	$("send-btn").hidden = working && !hasText;
}
input.addEventListener("input", () => {
	autosize();
	updateComposer();
});
input.addEventListener("keydown", (event) => {
	// Enter sends on a keyboard with a real Enter; phones get a newline.
	if (event.key === "Enter" && !event.shiftKey && !matchMedia("(pointer: coarse)").matches) {
		event.preventDefault();
		$("composer").requestSubmit();
	}
});
$("stop-btn").addEventListener("click", () => postComment("/stop", { quiet: true }));

$("composer").addEventListener("submit", async (event) => {
	event.preventDefault();
	const text = input.value.trim();
	if (!text) return;
	input.value = "";
	autosize();
	if (!current) {
		await createChat(text);
	} else {
		await postComment(text);
	}
});

async function createChat(text) {
	$("empty").hidden = true;
	$("messages").innerHTML = `<div class="msg-user sending">${escapeHtml(text)}</div>`;
	try {
		const issue = (await gh(repoPath("/issues"), { method: "POST", body: { title: chatTitle(text), body: text } })).data;
		chats.unshift(issue);
		current = { number: issue.number, title: issue.title, issue, comments: [] };
		history.replaceState(null, "", `?chat=${issue.number}`);
		$("chat-title").textContent = issue.title;
		renderChatList();
		renderMessages();
		refreshChat();
	} catch (err) {
		input.value = text;
		autosize();
		$("messages").innerHTML = "";
		$("empty").hidden = false;
		toast(err.message);
	}
	updateComposer();
}

async function postComment(text, { quiet = false } = {}) {
	if (!current) return;
	if (!quiet) {
		pending.push(text);
		renderMessages();
		scrollToBottom();
	}
	try {
		await gh(repoPath(`/issues/${current.number}/comments`), { method: "POST", body: { body: text } });
		refreshChat();
	} catch (err) {
		pending = pending.filter((item) => item !== text);
		if (!quiet) {
			input.value = text;
			autosize();
		}
		renderMessages();
		toast(err.message);
	}
}

// ---------- notifications ----------

function urlBase64ToUint8Array(base64) {
	const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
	return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

async function updateNotifyButton() {
	const button = $("notify-btn");
	if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
		button.textContent = isIos && !isStandalone ? "Notifications: add to Home Screen first" : "Notifications not supported here";
		button.disabled = true;
		return;
	}
	const registration = await navigator.serviceWorker.ready;
	const subscription = await registration.pushManager.getSubscription();
	button.textContent = subscription ? "Notifications on (send test)" : "Turn on notifications";
	button.disabled = false;
}

$("notify-btn").addEventListener("click", async () => {
	try {
		const registration = await navigator.serviceWorker.ready;
		let subscription = await registration.pushManager.getSubscription();
		if (subscription) {
			await registration.showNotification("minh", { body: "Notifications work on this device.", icon: "icon-192.png", badge: "icon-192.png" });
			return;
		}
		const permission = await Notification.requestPermission();
		if (permission !== "granted") throw new Error("Notifications were not allowed.");
		const key = (await gh(repoPath("/contents/.minh/vapid-public-key.txt"), { accept: "application/vnd.github.raw" })).data;
		if (!key) throw new Error("No key in the repo yet. Start the bridge once first.");
		subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(String(key).trim()),
		});
		await saveSubscription(subscription);
		toast("Notifications on.");
	} catch (err) {
		toast(err.message === "Repo not found, or the token cannot see it." ? "No key in the repo yet. Start the bridge once first." : err.message);
	}
	updateNotifyButton();
});

async function saveSubscription(subscription) {
	const path = `/contents/.minh/push/${settings.deviceId}.json`;
	let sha;
	try {
		sha = (await gh(repoPath(path))).data.sha;
	} catch {}
	const content = btoa(JSON.stringify(subscription.toJSON(), null, 2));
	await gh(repoPath(path), {
		method: "PUT",
		body: { message: `minh: notifications for device ${settings.deviceId}`, content, ...(sha ? { sha } : {}) },
	});
}

// ---------- start ----------

document.addEventListener("visibilitychange", () => {
	if (document.visibilityState !== "visible") return;
	refreshList();
	if (current) refreshChat();
});

function start() {
	$("setup").hidden = true;
	$("app").hidden = false;
	$("account-name").textContent = `${settings.login || ""} · ${settings.repo}`;
	refreshList();
	clearInterval(listTimer);
	listTimer = setInterval(() => document.visibilityState === "visible" && refreshList(), LIST_POLL_MS);
	const wanted = Number(new URLSearchParams(location.search).get("chat"));
	if (wanted) openChat(wanted);
	else newChat();
	updateNotifyButton().catch(() => {});
}

if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("sw.js").catch(() => {});
	navigator.serviceWorker.addEventListener("message", (event) => {
		if (event.data?.type === "open-chat") openChat(Number(event.data.chat));
	});
}

if (settings.token && settings.repo) {
	start();
} else {
	$("setup").hidden = false;
	const form = $("setup-form");
	if (settings.repo) form.repo.value = settings.repo;
	if (settings.apiBase) form.apiBase.value = settings.apiBase;
}
