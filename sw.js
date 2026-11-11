// Keeps the app opening offline and shows push notifications from the bridge.
const CACHE = "minh-v4";
const SHELL = ["./", "index.html", "app.js", "style.css", "manifest.webmanifest", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(SHELL.map((path) => new Request(path, { cache: "no-cache" }))))
			.then(() => self.skipWaiting()),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
			.then(() => self.clients.claim()),
	);
});

// App files: network first so updates show up, cache when offline.
// "no-cache" asks the server every time (a cheap 304 when nothing changed):
// GitHub Pages lets browsers keep files 10 minutes, which can pair a new
// index.html with an old app.js. Everything else (the GitHub API) goes
// straight to the network.
self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
	event.respondWith(
		fetch(event.request, { cache: "no-cache" })
			.then((response) => {
				const copy = response.clone();
				caches.open(CACHE).then((cache) => cache.put(event.request, copy));
				return response;
			})
			.catch(() => caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html"))),
	);
});

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {
		data = { body: event.data?.text() };
	}
	event.waitUntil(
		self.registration.showNotification(data.title || "minh", {
			body: data.body || "",
			icon: "icon-192.png",
			badge: "icon-192.png",
			tag: data.issue ? `chat-${data.issue}` : undefined,
			renotify: true,
			data: { chat: data.issue },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const chat = event.notification.data?.chat;
	const target = new URL(chat ? `./?chat=${chat}&push=1` : "./?push=1", self.registration.scope).href;
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
			for (const client of windows) {
				if (client.url.startsWith(self.registration.scope)) {
					client.postMessage({ type: "open-chat", chat });
					return client.focus();
				}
			}
			return self.clients.openWindow(target);
		}),
	);
});
