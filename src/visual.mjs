// Visual mode: for every tool that declares a ui:// resource, read the widget
// HTML, host it in the device frame (with a host bridge that answers the MCP
// Apps postMessage protocol and routes tools/call through the inspector), and
// screenshot it on the small and large Alexa surfaces with Playwright.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { widgetUri } from "./verdict.mjs";

export const SURFACES = {
  small: { width: 1024, height: 600, label: "small (10\" and below)" },
  large: { width: 1280, height: 800, label: "large (11\" and above)" }
};

const FRAME = resolve(import.meta.dirname, "../ui/device-frame.html");

export async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("visual mode needs Playwright: npm install playwright && npx playwright install chromium");
  }
}

/** Read every widget's HTML through the inspector (recorded) and write it under widgets/. */
export async function fetchWidgets(inspector) {
  const dir = join(inspector.recorder.outDir, "widgets");
  mkdirSync(dir, { recursive: true });
  const widgets = [];
  for (const tool of inspector.tools) {
    const uri = widgetUri(tool);
    if (!uri) continue;
    const read = await inspector.client.readResource(uri);
    const content = read.message?.result?.contents?.find((c) => typeof c.text === "string");
    if (!content) {
      inspector.fail(`resources/read ${uri}`, read.message?.error?.message ?? `HTTP ${read.status}`);
      continue;
    }
    const file = join(dir, `${tool.name}.html`);
    writeFileSync(file, content.text);
    widgets.push({ tool: tool.name, uri, mimeType: content.mimeType, file });
  }
  return widgets;
}

/**
 * Screenshot each widget on each surface. Returns [{ tool, surface, file, issues }].
 * `proxyPort` lets the frame route the widget's tools/call to the proxy.
 */
export async function screenshotWidgets(inspector, { proxyPort, surfaces = SURFACES } = {}) {
  const widgets = await fetchWidgets(inspector);
  if (!widgets.length) return [];
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const shots = [];
  try {
    for (const widget of widgets) {
      const lastResult =
        inspector.lastToolResult?.tool === widget.tool ? inspector.lastToolResult.result?.result : undefined;
      for (const [surface, size] of Object.entries(surfaces)) {
        const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
        const frameUrl = new URL(pathToFileURL(FRAME));
        frameUrl.searchParams.set("surface", surface);
        frameUrl.searchParams.set("tool", widget.tool);
        frameUrl.searchParams.set("api", `http://127.0.0.1:${proxyPort}`);
        await page.goto(frameUrl.toString());
        await page.evaluate(
          ({ html, result }) => window.inspectorLoadWidget(html, result),
          { html: readFileSync(widget.file, "utf8"), result: lastResult ?? null }
        );
        await page.waitForTimeout(600);
        const issues = await page.evaluate(() => window.inspectorAudit());
        const file = join(inspector.recorder.outDir, "screenshots", `${widget.tool}-${surface}.png`);
        await page.screenshot({ path: file, fullPage: false });
        await page.close();
        const shot = { tool: widget.tool, surface, size: `${size.width}x${size.height}`, file, issues };
        shots.push(shot);
        inspector.screenshots.push(shot);
        inspector.emitEvent("screenshot", shot);
      }
    }
  } finally {
    await browser.close();
  }
  inspector.snapshot();
  return shots;
}
