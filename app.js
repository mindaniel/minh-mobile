// minh phone app. Talks only to GitHub: each chat is an issue in your private
// chat repo, each message a comment. The bridge on the server answers.
// Comment format: see bridge/protocol.ts.

const $ = (id) => document.getElementById(id);
// Shown at the bottom of the drawer. Bump with each release, with the ?v= in index.html.
const APP_VERSION = "v5";
const APP_UPDATED = "2026-11-10";
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
// A connection is one machine's bridge: its repo, token and picks. The active
// one's fields also sit at the top level of `settings`, where the rest of the
// app reads them; saving one of them updates the connection too.
const PER_CONNECTION = ["name", "repo", "token", "apiBase", "login", "draftOptions", "typedFolders"];

function saveSettings(next) {
	settings = { ...settings, ...next };
	const active = activeConnection();
	if (active) {
		for (const key of PER_CONNECTION) if (key in next) active[key] = next[key];
	}
	try {
		localStorage.setItem(STORE_KEY, JSON.stringify(settings));
	} catch {}
}
function activeConnection() {
	return (settings.connections || []).find((c) => c.id === settings.activeId);
}
const repoName = (repo) => (repo || "").split("/")[1] || repo || "minh";

let settings = loadSettings();
if (!settings.deviceId) saveSettings({ deviceId: crypto.randomUUID().slice(0, 8) });
// Older versions held one repo; it becomes the first connection.
if (!settings.connections) {
	const connections =
		settings.repo && settings.token
			? [
					{
						id: crypto.randomUUID().slice(0, 8),
						name: repoName(settings.repo),
						...Object.fromEntries(PER_CONNECTION.filter((k) => k in settings).map((k) => [k, settings[k]])),
					},
				]
			: [];
	saveSettings({ connections, activeId: connections[0]?.id });
	if (connections[0]) saveSettings({ name: connections[0].name });
}

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

// Chat settings line: top of the issue body, or a comment of its own mid-chat.
const OPTIONS = /^<!-- minh-options (\{.*?\}) -->\r?\n?/;
function readOptions(body) {
	const match = OPTIONS.exec(body || "");
	if (!match) return undefined;
	try {
		return JSON.parse(match[1]);
	} catch {
		return {};
	}
}
const stripOptions = (body) => (body || "").replace(OPTIONS, "");
const withOptions = (options, text) => `<!-- minh-options ${JSON.stringify(options)} -->\n${text}`;

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
	const name = String(form.get("name") || "").trim() || repoName(repo);
	const error = $("setup-error");
	error.hidden = true;
	const button = event.target.querySelector("button[type=submit]");
	button.disabled = true;
	const previous = settings;
	// Try the new repo and token without touching the saved connections yet.
	settings = { ...settings, repo, token, apiBase };
	try {
		if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Repo should look like your-name/minh-chat.");
		const user = (await gh("/user")).data;
		await gh(repoPath());
		settings = previous;
		const connections = [...(settings.connections || [])];
		// The same repo again replaces its connection (a new token, say).
		const existing = connections.find((c) => c.repo.toLowerCase() === repo.toLowerCase());
		const connection = {
			...(existing || { id: crypto.randomUUID().slice(0, 8) }),
			name,
			repo,
			token,
			apiBase,
			login: user.login,
		};
		saveSettings({
			connections: existing ? connections.map((c) => (c.id === existing.id ? connection : c)) : [...connections, connection],
		});
		switchConnection(connection.id);
		event.target.reset();
	} catch (err) {
		settings = previous;
		error.textContent = err.message;
		error.hidden = false;
	} finally {
		button.disabled = false;
	}
});

function showSetup() {
	$("app").hidden = true;
	$("setup").hidden = false;
	$("setup-error").hidden = true;
	$("setup-back").hidden = !(settings.connections || []).length;
	$("setup-form").name.focus();
}
$("setup-back").addEventListener("click", () => {
	$("setup").hidden = true;
	$("app").hidden = false;
});

// ---------- connections ----------

/** Make another connection the active one and reload everything from its repo. */
function switchConnection(id) {
	const connection = (settings.connections || []).find((c) => c.id === id);
	if (!connection) return;
	const fields = Object.fromEntries(PER_CONNECTION.map((key) => [key, connection[key]]));
	settings = { ...settings, activeId: id };
	saveSettings(fields);
	clearTimeout(chatTimer);
	clearInterval(listTimer);
	etags.clear();
	chats = [];
	archived = [];
	current = null;
	pending = [];
	catalog = null;
	showArchived = false;
	$("search").value = "";
	history.replaceState(null, "", location.pathname);
	start();
}

function renderConnections() {
	const list = settings.connections || [];
	$("conn-list").innerHTML = list
		.map(
			(c) =>
				`<button type="button" data-id="${escapeHtml(c.id)}"><b class="tick">${c.id === settings.activeId ? "✓" : ""}</b><span>${escapeHtml(c.name || repoName(c.repo))}<small>${escapeHtml(`${c.login || ""} · ${c.repo}`)}</small></span></button>`,
		)
		.join("");
}
function openConnections(open) {
	if (open) renderConnections();
	$("conn-sheet").hidden = !open;
	$("sheet-scrim").hidden = !open;
}

$("conn-btn").addEventListener("click", () => openConnections(true));
$("conn-sheet").addEventListener("click", (event) => {
	const pick = event.target.closest("[data-id]");
	if (pick) {
		openConnections(false);
		openDrawer(false);
		if (pick.dataset.id !== settings.activeId) {
			switchConnection(pick.dataset.id);
			toast(`Switched to ${settings.name}.`);
		}
		return;
	}
	const action = event.target.closest("[data-conn]")?.dataset.conn;
	if (!action) return;
	openConnections(false);
	if (action === "add") {
		openDrawer(false);
		showSetup();
	} else if (action === "rename") {
		const name = prompt("Name this connection", settings.name || "")?.trim();
		if (name) {
			saveSettings({ name });
			updateConnectionLabel();
		}
	} else if (action === "remove") {
		if (!confirm(`Remove "${settings.name}" from this phone? Its chats stay in ${settings.repo}.`)) return;
		const rest = (settings.connections || []).filter((c) => c.id !== settings.activeId);
		if (settings.pushRepo === settings.repo) saveSettings({ pushRepo: undefined });
		settings = { ...settings, activeId: undefined };
		saveSettings({ connections: rest });
		if (rest.length) {
			switchConnection(rest[0].id);
		} else {
			saveSettings(Object.fromEntries(PER_CONNECTION.map((key) => [key, undefined])));
			location.replace(location.pathname);
		}
	}
});

function updateConnectionLabel() {
	$("conn-name").textContent = settings.name || repoName(settings.repo);
	$("account-name").textContent = `${settings.login || ""} · ${settings.repo}`;
}

// ---------- drawer ----------

function openDrawer(open) {
	$("drawer").classList.toggle("open", open);
	$("scrim").hidden = !open;
}
$("menu-btn").addEventListener("click", () => openDrawer(true));
$("scrim").addEventListener("click", () => openDrawer(false));
$("new-btn").addEventListener("click", () => newChat());
$("drawer-new").addEventListener("click", () => newChat());

// Pinned chats carry this label; deleted ones (when GitHub won't really delete) carry the other.
const PIN_LABEL = "pinned";
const DELETED_LABEL = "deleted";
const hasLabel = (issue, name) => (issue.labels || []).some((label) => (label.name || label) === name);
const isChat = (issue) => !issue.pull_request && !hasLabel(issue, DELETED_LABEL);

let archived = [];
let showArchived = false;

function chatButton(chat) {
	const pin = hasLabel(chat, PIN_LABEL) ? `<span class="pin">●</span>` : "";
	return `<button class="chat-item${current?.number === chat.number ? " active" : ""}" data-n="${chat.number}">${pin}${escapeHtml(chat.title)}<small>${relativeTime(chat.updated_at)}</small></button>`;
}

function renderChatList() {
	const list = $("chat-list");
	const query = $("search").value.trim().toLowerCase();
	const match = (chat) => !query || chat.title.toLowerCase().includes(query);
	$("archived-btn").textContent = showArchived ? "Back to chats" : "Archived chats";
	if (showArchived) {
		const shown = archived.filter(match);
		list.innerHTML =
			`<p class="drawer-label">Archived</p>` +
			(shown.length ? shown.map(chatButton).join("") : `<p class="none">${query ? "No matches." : "Nothing archived."}</p>`);
		return;
	}
	const shown = chats.filter(match);
	if (!shown.length) {
		list.innerHTML = `<p class="none">${query ? "No matches." : "No chats yet."}</p>`;
		return;
	}
	const pinned = shown.filter((chat) => hasLabel(chat, PIN_LABEL));
	const rest = shown.filter((chat) => !hasLabel(chat, PIN_LABEL));
	list.innerHTML =
		(pinned.length ? `<p class="drawer-label">Pinned</p>${pinned.map(chatButton).join("")}` : "") +
		(rest.length ? `<p class="drawer-label">Recents</p>${rest.map(chatButton).join("")}` : "");
}

// A tap opens a chat; a long press (or right click) opens its actions.
let pressTimer = 0;
let pressed = false;
$("chat-list").addEventListener("pointerdown", (event) => {
	const item = event.target.closest("[data-n]");
	pressed = false;
	if (!item || event.button !== 0) return;
	clearTimeout(pressTimer);
	pressTimer = setTimeout(() => {
		pressed = true;
		navigator.vibrate?.(10);
		openActions(Number(item.dataset.n));
	}, 500);
});
for (const type of ["pointerup", "pointercancel", "pointerleave", "scroll"]) {
	$("chat-list").addEventListener(type, () => clearTimeout(pressTimer), true);
}
$("chat-list").addEventListener("contextmenu", (event) => {
	const item = event.target.closest("[data-n]");
	if (!item) return;
	event.preventDefault();
	clearTimeout(pressTimer);
	if (!pressed) openActions(Number(item.dataset.n));
	pressed = true;
});
$("chat-list").addEventListener("click", (event) => {
	const item = event.target.closest("[data-n]");
	if (!item) return;
	if (pressed) {
		pressed = false;
		return;
	}
	openDrawer(false);
	openChat(Number(item.dataset.n));
});
$("search").addEventListener("input", renderChatList);
$("archived-btn").addEventListener("click", () => {
	showArchived = !showArchived;
	renderChatList();
	if (showArchived) refreshArchived();
});

async function refreshList() {
	try {
		const { data, changed } = await gh(repoPath("/issues?state=open&sort=updated&direction=desc&per_page=50"), {
			conditional: true,
		});
		if (!changed && chats.length) return;
		chats = (data || []).filter(isChat);
		renderChatList();
	} catch (err) {
		$("status-line").textContent = err.message;
	}
}

async function refreshArchived() {
	try {
		const { data } = await gh(repoPath("/issues?state=closed&sort=updated&direction=desc&per_page=50"), {
			conditional: true,
		});
		archived = (data || []).filter(isChat);
		renderChatList();
	} catch (err) {
		toast(err.message);
	}
}

// ---------- chat actions ----------

const findChat = (number) =>
	chats.find((chat) => chat.number === number) ||
	archived.find((chat) => chat.number === number) ||
	(current?.number === number ? current.issue : undefined);

let actionsFor = null;

function openActions(number) {
	const issue = findChat(number);
	if (!issue) return;
	actionsFor = issue;
	$("actions-title").textContent = issue.title;
	const sheetEl = $("actions-sheet");
	sheetEl.querySelector('[data-act="pin"]').textContent = hasLabel(issue, PIN_LABEL) ? "Unpin" : "Pin";
	sheetEl.querySelector('[data-act="pin"]').hidden = issue.state === "closed";
	sheetEl.querySelector('[data-act="archive"]').textContent = issue.state === "closed" ? "Restore" : "Archive";
	sheetEl.hidden = false;
	$("sheet-scrim").hidden = false;
}
function closeActions() {
	$("actions-sheet").hidden = true;
	$("sheet-scrim").hidden = $("options-sheet").hidden;
}

$("chat-menu-btn").addEventListener("click", () => current && openActions(current.number));

/** Put a changed issue everywhere it shows. */
function applyIssue(issue) {
	chats = chats.filter((chat) => chat.number !== issue.number);
	archived = archived.filter((chat) => chat.number !== issue.number);
	if (isChat(issue)) {
		if (issue.state === "open") chats.unshift(issue);
		else archived.unshift(issue);
	}
	chats.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
	if (current?.number === issue.number) {
		current.issue = issue;
		current.title = issue.title;
		$("chat-title").textContent = issue.title;
	}
	renderChatList();
	updateChatMenu();
}

const refetchIssue = async (number) => (await gh(repoPath(`/issues/${number}`))).data;

async function deleteChat(issue) {
	// A real delete needs admin rights on the repo, which a phone token
	// usually lacks; then the chat is emptied, closed and hidden instead.
	try {
		const { data } = await gh("/graphql", {
			method: "POST",
			accept: "application/json",
			body: {
				query: "mutation($id: ID!) { deleteIssue(input: { issueId: $id }) { clientMutationId } }",
				variables: { id: issue.node_id },
			},
		});
		if (!data?.errors?.length) return { ...issue, labels: [{ name: DELETED_LABEL }] };
	} catch {}
	const { comments } = await fetchAllComments(issue.number);
	for (const comment of comments) {
		await gh(repoPath(`/issues/comments/${comment.id}`), { method: "DELETE" });
	}
	await gh(repoPath(`/issues/${issue.number}/labels`), { method: "POST", body: { labels: [DELETED_LABEL] } });
	return (
		await gh(repoPath(`/issues/${issue.number}`), {
			method: "PATCH",
			body: { title: "Deleted chat", body: "", state: "closed" },
		})
	).data;
}

$("actions-sheet").addEventListener("click", async (event) => {
	const button = event.target.closest("[data-act]");
	if (!button || !actionsFor) return;
	const issue = actionsFor;
	const act = button.dataset.act;
	closeActions();
	try {
		if (act === "rename") {
			const title = prompt("Rename chat", issue.title)?.trim();
			if (!title || title === issue.title) return;
			applyIssue((await gh(repoPath(`/issues/${issue.number}`), { method: "PATCH", body: { title } })).data);
		} else if (act === "pin") {
			if (hasLabel(issue, PIN_LABEL)) {
				await gh(repoPath(`/issues/${issue.number}/labels/${PIN_LABEL}`), { method: "DELETE" });
			} else {
				await gh(repoPath(`/issues/${issue.number}/labels`), { method: "POST", body: { labels: [PIN_LABEL] } });
			}
			applyIssue(await refetchIssue(issue.number));
		} else if (act === "archive") {
			const state = issue.state === "closed" ? "open" : "closed";
			applyIssue((await gh(repoPath(`/issues/${issue.number}`), { method: "PATCH", body: { state } })).data);
			toast(state === "closed" ? "Archived. Its minh session stops." : "Restored.");
			if (state === "closed" && current?.number === issue.number) newChat();
		} else if (act === "delete") {
			if (!confirm(`Delete "${issue.title}"? Its messages are removed for good.`)) return;
			toast("Deleting…");
			applyIssue(await deleteChat(issue));
			toast("Deleted.");
			if (current?.number === issue.number) newChat();
		}
	} catch (err) {
		toast(err.message);
	}
});

function updateChatMenu() {
	$("chat-menu-btn").hidden = !current;
	const closed = current?.issue?.state === "closed";
	$("composer").hidden = closed;
	if (closed) $("status-line").textContent = "";
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
	updateOptionsLabel();
	updateChatMenu();
	renderChatList();
	$("input").focus();
}

async function openChat(number) {
	clearTimeout(chatTimer);
	pending = [];
	const known = findChat(number);
	current = { number, title: known?.title || `#${number}`, issue: known, comments: [] };
	history.replaceState(null, "", `?chat=${number}`);
	$("chat-title").textContent = current.title;
	$("messages").innerHTML = "";
	$("empty").hidden = true;
	renderChatList();
	updateComposer();
	updateChatMenu();
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
		parts.push(`<div class="msg-user">${escapeHtml(stripOptions(current.issue.body).trim() || current.issue.title)}</div>`);
	}
	for (const comment of current.comments) {
		const marker = readMarker(comment.body);
		if (!marker) {
			if (readOptions(comment.body)) {
				parts.push(`<div class="msg-note">${escapeHtml(stripOptions(comment.body).trim() || "Settings changed")}</div>`);
			} else if (isCommand(comment.body)) {
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
		} else if (marker.kind === "user") {
			// Typed in a minh window on the server, copied in by the bridge.
			parts.push(`<div class="msg-user">${escapeHtml(comment.body.replace(MARKER, "").trim())}</div>`);
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
	// Waiting on the bridge: the last thing said is a message of yours with no reply yet.
	const said = current.comments.filter((c) => !readOptions(c.body));
	const last = said[said.length - 1];
	if (pending.length || (last && !readMarker(last.body) && !isCommand(last.body)) || (!said.length && current.issue)) {
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
	updateOptionsLabel();
	updateChatMenu();
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
		const options = newChatOptions();
		const body = Object.keys(options).length ? withOptions(options, text) : text;
		const issue = (await gh(repoPath("/issues"), { method: "POST", body: { title: chatTitle(text), body } })).data;
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

// ---------- model and settings ----------

// What the bridge can run, from .minh/options.json: { defaults, providers: [{ id, name, model, models }] }.
let catalog = null;

async function loadCatalog() {
	try {
		const { data } = await gh(repoPath("/contents/.minh/options.json"), {
			accept: "application/vnd.github.raw",
			conditional: true,
		});
		catalog = typeof data === "string" ? JSON.parse(data) : data;
	} catch {}
	updateOptionsLabel();
}

const providerInfo = (id) => catalog?.providers?.find((p) => p.id === id);
function modelName(provider, model) {
	return providerInfo(provider)?.models?.find((m) => m.id === model)?.name || model || "Default model";
}

/** Settings a new chat starts with: the bridge's defaults, then your last picks. */
function newChatOptions() {
	return { ...(catalog?.defaults || {}), ...(settings.draftOptions || {}) };
}

/** Settings the open chat runs with: what it started with, then each change in order. */
function chatOptions() {
	let options = { ...(catalog?.defaults || {}), ...(readOptions(current?.issue?.body) || {}) };
	for (const comment of current?.comments || []) {
		const change = readOptions(comment.body);
		if (change && !readMarker(comment.body)) options = { ...options, ...change };
	}
	return options;
}

const folderName = (path) => (path || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

function describeOptions(options) {
	const bits = [modelName(options.provider, options.model)];
	if (options.cwd) bits.push(folderName(options.cwd));
	if (options.mode === "plan") bits.push("Plan");
	if (options.autoApprove === false) bits.push("Ask me");
	return bits.join(" · ");
}

function updateOptionsLabel() {
	$("options-label").textContent = describeOptions(current ? chatOptions() : newChatOptions());
}

const sheet = $("options-sheet");
// Value of the "Other…" entries (model, folder): one no real model id or path uses.
const OTHER = "::other::";

function fillModels(provider, model) {
	const select = $("opt-model");
	const text = $("opt-model-text");
	const models = providerInfo(provider)?.models || [];
	if (!models.length) {
		select.hidden = true;
		text.hidden = false;
		text.value = model || providerInfo(provider)?.model || "";
		return;
	}
	const known = models.some((m) => m.id === model);
	select.innerHTML =
		models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join("") +
		`<option value="${OTHER}">Other…</option>`;
	select.hidden = false;
	select.value = known ? model : model ? OTHER : models[0].id;
	text.hidden = select.value !== OTHER;
	text.value = known ? "" : model || "";
}

/** The bridge's folders, plus ones typed on this device before. */
function fillFolders(cwd) {
	const select = $("opt-folder");
	const text = $("opt-folder-text");
	const seen = new Set();
	const folders = [...(catalog?.folders || []), ...(settings.typedFolders || [])].filter((path) => {
		const key = path.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	const known = cwd && folders.some((path) => path.toLowerCase() === cwd.toLowerCase());
	if (cwd && !known) folders.unshift(cwd);
	select.innerHTML =
		folders
			.map((path) => `<option value="${escapeHtml(path)}">${escapeHtml(`${folderName(path)} — ${path}`)}</option>`)
			.join("") + `<option value="${OTHER}">Other folder…</option>`;
	select.value = cwd ? folders.find((path) => path.toLowerCase() === cwd.toLowerCase()) : folders[0] || OTHER;
	text.value = "";
	showFolderText();
}

function showFolderText() {
	const other = $("opt-folder").value === OTHER;
	$("opt-folder-text").hidden = !other;
	$("folder-new").hidden = !other;
	const base = catalog?.defaults?.cwd;
	$("folder-new-hint").textContent = base
		? `A name alone, like "my-app", means a folder inside ${base}.`
		: `A name alone means a folder inside the bridge's default folder.`;
}

function setSegment(name, value) {
	for (const button of sheet.querySelectorAll(`.segmented[data-name="${name}"] button`)) {
		button.classList.toggle("on", button.dataset.value === String(value));
	}
}
function getSegment(name) {
	return sheet.querySelector(`.segmented[data-name="${name}"] button.on`)?.dataset.value;
}

async function openSheet(open) {
	sheet.hidden = !open;
	$("sheet-scrim").hidden = !open;
	if (!open) return;
	if (!catalog) await loadCatalog();
	const options = current ? chatOptions() : newChatOptions();
	$("sheet-title").textContent = current ? "This chat" : "New chat";
	const providers = [...(catalog?.providers || [])];
	if (options.provider && !providers.some((p) => p.id === options.provider)) {
		providers.unshift({ id: options.provider, name: options.provider, models: [] });
	}
	$("opt-provider").innerHTML = providers
		.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
		.join("");
	$("opt-provider").value = options.provider || providers[0]?.id || "";
	fillModels($("opt-provider").value, options.model);
	fillFolders(options.cwd);
	setSegment("mode", options.mode || "act");
	setSegment("autoApprove", options.autoApprove ?? true);
	$("sheet-hint").textContent = !catalog
		? "No model list yet. Start the bridge once; it lists the providers you set up in minh."
		: current
			? "Applies from your next message. A new model keeps this chat's history."
			: "Used for new chats from now on.";
}

$("options-btn").addEventListener("click", () => openSheet(true));
$("sheet-scrim").addEventListener("click", () => {
	openSheet(false);
	closeActions();
	openConnections(false);
});
$("opt-provider").addEventListener("change", (event) => {
	fillModels(event.target.value, providerInfo(event.target.value)?.model);
});
$("opt-folder").addEventListener("change", (event) => {
	showFolderText();
	if (event.target.value === OTHER) $("opt-folder-text").focus();
});
$("opt-model").addEventListener("change", (event) => {
	$("opt-model-text").hidden = event.target.value !== OTHER;
	if (event.target.value === OTHER) $("opt-model-text").focus();
});
sheet.addEventListener("click", (event) => {
	const button = event.target.closest(".segmented button");
	if (button) setSegment(button.parentElement.dataset.name, button.dataset.value);
});

sheet.addEventListener("submit", async (event) => {
	event.preventDefault();
	const select = $("opt-model");
	const model = (select.hidden || select.value === OTHER ? $("opt-model-text").value : select.value).trim();
	const folderSelect = $("opt-folder");
	const cwd = (folderSelect.value === OTHER ? $("opt-folder-text").value : folderSelect.value).trim();
	if (cwd && folderSelect.value === OTHER) {
		saveSettings({ typedFolders: [cwd, ...(settings.typedFolders || []).filter((p) => p !== cwd)].slice(0, 10) });
	}
	const picked = {
		...($("opt-provider").value ? { provider: $("opt-provider").value } : {}),
		...(model ? { model } : {}),
		...(cwd ? { cwd } : {}),
		...(cwd && folderSelect.value === OTHER && $("opt-folder-create").checked ? { createFolder: true } : {}),
		mode: getSegment("mode") || "act",
		autoApprove: getSegment("autoApprove") !== "false",
	};
	openSheet(false);
	saveSettings({ draftOptions: picked });
	if (current) {
		const before = chatOptions();
		const change = Object.fromEntries(Object.entries(picked).filter(([key, value]) => before[key] !== value));
		if (Object.keys(change).length) {
			await postComment(withOptions(change, `Switched to ${describeOptions({ ...before, ...picked })}`), { quiet: true });
		}
	}
	updateOptionsLabel();
});

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
	// Subscribed before connections existed: it belongs to the one showing.
	if (subscription && !settings.pushRepo) saveSettings({ pushRepo: settings.repo });
	const elsewhere = subscription && settings.pushRepo !== settings.repo;
	const from = (settings.connections || []).find((c) => c.repo === settings.pushRepo);
	button.textContent = !subscription
		? "Turn on notifications"
		: elsewhere
			? `Notifications come from ${from?.name || settings.pushRepo}. Get them from here instead`
			: "Notifications on (send test)";
	button.disabled = false;
}

$("notify-btn").addEventListener("click", async () => {
	try {
		const registration = await navigator.serviceWorker.ready;
		let subscription = await registration.pushManager.getSubscription();
		if (subscription && settings.pushRepo === settings.repo) {
			await registration.showNotification("minh", { body: "Notifications work on this device.", icon: "icon-192.png", badge: "icon-192.png" });
			return;
		}
		const permission = await Notification.requestPermission();
		if (permission !== "granted") throw new Error("Notifications were not allowed.");
		const key = (await gh(repoPath("/contents/.minh/vapid-public-key.txt"), { accept: "application/vnd.github.raw" })).data;
		if (!key) throw new Error("No key in the repo yet. Start the bridge once first.");
		// One browser takes push from one bridge (each signs with its own key):
		// moving here drops the other; its bridge forgets this phone on its own.
		if (subscription) await subscription.unsubscribe();
		subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(String(key).trim()),
		});
		await saveSubscription(subscription);
		saveSettings({ pushRepo: settings.repo });
		toast(`Notifications on for ${settings.name || settings.repo}.`);
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
	updateConnectionLabel();
	$("app-version").textContent = `App ${APP_VERSION} · updated ${APP_UPDATED}`;
	refreshList();
	loadCatalog();
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
		if (event.data?.type !== "open-chat") return;
		// The notification came from the connection notifications are set up for.
		const from = (settings.connections || []).find((c) => c.repo === settings.pushRepo);
		if (from && from.id !== settings.activeId) switchConnection(from.id);
		openChat(Number(event.data.chat));
	});
}

// Opened from a notification: it came from the connection notifications are
// set up for, which may not be the one showing.
const fromPush = new URLSearchParams(location.search).get("push") === "1";
const pushConnection = (settings.connections || []).find((c) => c.repo === settings.pushRepo);
if (fromPush && pushConnection && pushConnection.id !== settings.activeId) {
	const chat = new URLSearchParams(location.search).get("chat");
	settings = { ...settings, activeId: pushConnection.id };
	saveSettings(Object.fromEntries(PER_CONNECTION.map((key) => [key, pushConnection[key]])));
	if (chat) history.replaceState(null, "", `?chat=${chat}`);
}

if (settings.token && settings.repo) {
	start();
} else {
	showSetup();
}
