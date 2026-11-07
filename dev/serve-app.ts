// Serves app/ on http://localhost:8791 for trying it in a desktop browser.
// Phones need HTTPS, so on a phone use the GitHub Pages copy instead.
import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "app");
const server = Bun.serve({
	port: Number(process.env.PORT) || 8791,
	fetch(request) {
		const path = new URL(request.url).pathname;
		const file = normalize(join(root, path === "/" ? "index.html" : path));
		if (!file.startsWith(root) || !existsSync(file)) return new Response("Not found", { status: 404 });
		return new Response(Bun.file(file));
	},
});
console.log(`app on http://localhost:${server.port}`);
