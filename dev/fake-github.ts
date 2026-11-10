/**
 * A pretend GitHub for trying the bridge and the app on one machine without
 * real tokens: the handful of REST endpoints they use, in memory, with ETags
 * and CORS. Any token works; the token's text is the login ("you", "bot").
 *
 *   bun dev/fake-github.ts            (port 8790)
 */

type Issue = {
	number: number;
	title: string;
	body: string | null;
	state: "open" | "closed";
	user: { login: string };
	labels: Array<{ name: string }>;
	node_id: string;
	created_at: string;
	updated_at: string;
};
type Comment = {
	id: number;
	body: string;
	user: { login: string };
	issue_url: string;
	created_at: string;
	updated_at: string;
};

export function createFakeGitHub(options: { port?: number; repo?: string } = {}) {
	const repo = options.repo ?? "you/minh-chat";
	const issues: Issue[] = [];
	const comments: Comment[] = [];
	const files = new Map<string, { content: string; sha: number }>();
	let nextComment = 1000;
	let sha = 1;
	let clock = Date.now();
	// Strictly increasing timestamps, like a real server's.
	const now = () => new Date((clock = Math.max(clock + 1, Date.now()))).toISOString();

	const cors = {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Headers": "*",
		"Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
		"Access-Control-Expose-Headers": "ETag, Link, X-RateLimit-Remaining",
	};
	const json = (data: unknown, status = 200, request?: Request) => {
		const text = JSON.stringify(data);
		const etag = `"${Bun.hash(text).toString(16)}"`;
		if (request?.headers.get("if-none-match") === etag) {
			return new Response(null, { status: 304, headers: { ...cors, ETag: etag } });
		}
		return new Response(text, {
			status,
			headers: { ...cors, "Content-Type": "application/json", ETag: etag },
		});
	};
	const escape = (text: string) =>
		text.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);
	// Crude stand-in for GitHub's markdown rendering: hides the marker, keeps paragraphs and code.
	const html = (body: string | null) =>
		(body ?? "")
			.replace(/^<!-- minh .*? -->\n?/, "")
			.split(/\n{2,}/)
			.map((block) =>
				block.startsWith("```")
					? `<pre><code>${escape(block.replace(/^```\w*\n?|```$/g, ""))}</code></pre>`
					: block.startsWith("<")
						? block
						: block.startsWith("- ")
							? `<ul>${block.replace(/^- (.*)$/gm, (_, item: string) => `<li>${escape(item).replace(/`([^`]+)`/g, "<code>$1</code>")}</li>`)}</ul>`
						: `<p>${escape(block).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\n/g, "<br>")}</p>`,
			)
			.join("");
	const withHtml = <T extends { body: string | null }>(item: T) => ({ ...item, body_html: html(item.body) });
	const issueUrl = (n: number) => `http://localhost/repos/${repo}/issues/${n}`;

	const server = Bun.serve({
		port: options.port ?? 8790,
		async fetch(request) {
			if (request.method === "OPTIONS") return new Response(null, { headers: cors });
			const url = new URL(request.url);
			const login = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
			if (!login) return json({ message: "Bad credentials" }, 401);
			const path = url.pathname;
			const body = ["POST", "PATCH", "PUT", "DELETE"].includes(request.method)
				? ((await request.json().catch(() => ({}))) as Record<string, any>)
				: {};
			const base = `/repos/${repo}`;

			if (path === "/user") return json({ login });
			if (path === "/user/repository_invitations") return json([]);
			if (path === base) return json({ full_name: repo, private: true, permissions: { push: true } });

			if (path === `${base}/issues` && request.method === "GET") {
				const state = url.searchParams.get("state") ?? "open";
				const list = issues
					.filter((issue) => state === "all" || issue.state === state)
					.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
				return json(list.map(withHtml), 200, request);
			}
			if (path === `${base}/issues` && request.method === "POST") {
				const issue: Issue = {
					number: issues.length + 1,
					title: body.title,
					body: body.body ?? null,
					state: "open",
					user: { login },
					labels: [],
					node_id: `I_${issues.length + 1}`,
					created_at: now(),
					updated_at: now(),
				};
				issues.push(issue);
				return json(withHtml(issue), 201);
			}
			// Like a token without admin rights: deleting issues is refused.
			if (path === "/graphql") {
				return json({ errors: [{ type: "FORBIDDEN", message: "Resource not accessible by personal access token" }] });
			}
			let match = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels(?:\/([^/]+))?$/.exec(path);
			if (match) {
				const issue = issues.find((item) => item.number === Number(match![1]));
				if (!issue) return json({ message: "Not Found" }, 404);
				if (request.method === "POST") {
					for (const name of body.labels as string[]) {
						if (!issue.labels.some((label) => label.name === name)) issue.labels.push({ name });
					}
				} else if (request.method === "DELETE" && match[2]) {
					issue.labels = issue.labels.filter((label) => label.name !== decodeURIComponent(match![2]));
				}
				issue.updated_at = now();
				return json(issue.labels);
			}
			match = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(path);
			if (match) {
				const issue = issues.find((item) => item.number === Number(match![1]));
				if (!issue) return json({ message: "Not Found" }, 404);
				if (request.method === "PATCH") Object.assign(issue, body, { updated_at: now() });
				return json(withHtml(issue), 200, request);
			}
			match = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(path);
			if (match) {
				const n = Number(match[1]);
				const issue = issues.find((item) => item.number === n);
				if (!issue) return json({ message: "Not Found" }, 404);
				if (request.method === "POST") {
					const comment: Comment = {
						id: nextComment++,
						body: body.body,
						user: { login },
						issue_url: issueUrl(n),
						created_at: now(),
						updated_at: now(),
					};
					comments.push(comment);
					issue.updated_at = comment.updated_at;
					return json(withHtml(comment), 201);
				}
				const page = Number(url.searchParams.get("page") ?? 1);
				const perPage = Number(url.searchParams.get("per_page") ?? 30);
				const list = comments.filter((c) => c.issue_url === issueUrl(n));
				return json(list.slice((page - 1) * perPage, page * perPage).map(withHtml), 200, request);
			}
			if (path === `${base}/issues/comments`) {
				const since = url.searchParams.get("since") ?? "";
				const list = comments
					.filter((c) => c.updated_at >= since)
					.sort((a, b) => a.updated_at.localeCompare(b.updated_at))
					.slice(0, Number(url.searchParams.get("per_page") ?? 30));
				return json(list.map(withHtml), 200, request);
			}
			match = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(path);
			if (match) {
				const comment = comments.find((c) => c.id === Number(match![1]));
				if (!comment) return json({ message: "Not Found" }, 404);
				if (request.method === "DELETE") {
					comments.splice(comments.indexOf(comment), 1);
					return new Response(null, { status: 204, headers: cors });
				}
				if (request.method === "PATCH") {
					comment.body = body.body;
					comment.updated_at = now();
					const issue = issues.find((item) => issueUrl(item.number) === comment.issue_url);
					if (issue) issue.updated_at = comment.updated_at;
				}
				return json(withHtml(comment));
			}
			match = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(path);
			if (match) {
				const filePath = decodeURIComponent(match[1]);
				if (request.method === "PUT") {
					files.set(filePath, { content: body.content, sha: sha++ });
					return json({ content: { path: filePath } }, 201);
				}
				if (request.method === "DELETE") {
					files.delete(filePath);
					return json({});
				}
				const file = files.get(filePath);
				if (file) {
					if (request.headers.get("accept") === "application/vnd.github.raw") {
						return new Response(Buffer.from(file.content, "base64"), { headers: cors });
					}
					return json({ content: file.content, sha: String(file.sha), path: filePath });
				}
				const folder = [...files.entries()].filter(([key]) => key.startsWith(`${filePath}/`));
				if (folder.length) {
					return json(
						folder.map(([key, value]) => ({ name: key.slice(filePath.length + 1), path: key, sha: String(value.sha), type: "file" })),
						200,
						request,
					);
				}
				return json({ message: "Not Found" }, 404);
			}
			return json({ message: `fake-github: no route for ${request.method} ${path}` }, 404);
		},
	});
	return { server, url: `http://localhost:${server.port}`, repo, issues, comments, files };
}

if (import.meta.main) {
	const fake = createFakeGitHub();
	console.log(`fake GitHub on ${fake.url}, repo ${fake.repo}. Any token works; the token is the login.`);
}
