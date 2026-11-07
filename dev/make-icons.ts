// Renders app/icon.svg to the PNG sizes phones want (iOS ignores SVG icons).
// Uses the Playwright that clinemin already installs; run once after changing the icon.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const { chromium } = (await import(
	pathToFileURL(resolve(root, "..", "clinemin", "node_modules", "playwright", "index.mjs")).href
)) as { chromium: { launch(options?: object): Promise<any> } };

const svg = readFileSync(join(root, "app", "icon.svg"), "utf-8");
const browser = await chromium.launch({ channel: "chrome", timeout: 60_000 });
try {
	for (const size of [180, 192, 512]) {
		// Full-bleed square: iOS and Android round the corners themselves.
		const square = svg.replace('rx="14"', 'rx="0"');
		const page = await browser.newPage({ viewport: { width: size, height: size } });
		await page.setContent(
			`<html><body style="margin:0">${square.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`,
		);
		await page.screenshot({ path: join(root, "app", `icon-${size}.png`), omitBackground: true });
		await page.close();
		console.log(`app/icon-${size}.png`);
	}
} finally {
	await browser.close();
}
