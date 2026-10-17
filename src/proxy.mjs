// The localhost proxy (default :6277) and the UI static server (default
// :6274), with the endpoints of Amazon's local inspector plus the extensions
// that drive the voice flow, account linking and the verdict.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parseRpcMessages } from "./mcp-client.mjs";

const UI_DIR = resolve(import.meta.dirname, "../ui");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function isLoopback(socket) {
  const address = socket.remoteAddress ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function json(response, status, value, extra = {}) {
  response.writeHead(status, { "content-type": "application/json", ...extra });
  response.end(JSON.stringify(value));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export function createProxyServer(inspector, { clientPort = 6274, onLink, onVisual } = {}) {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, accept, mcp-protocol-version, mcp-session-id",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS"
  };
  const server = createServer(async (request, response) => {
    if (!isLoopback(request.socket)) {
      response.writeHead(403).end("localhost only");
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    if (method === "OPTIONS") return response.writeHead(204, cors).end();
    try {
      // ---- the official endpoints
      if (url.pathname === "/health")
        return json(response, 200, { status: inspector.status, server: inspector.serverUrl }, cors);
      if (url.pathname === "/state") return json(response, 200, inspector.state(), cors);
      if (url.pathname === "/events") return events(request, response, inspector, cors);
      if (url.pathname === "/mcp" && method === "POST") return mcp(request, response, inspector, cors);
      if (url.pathname === "/mcp" && method === "GET") return mcpGet(request, response, inspector, cors);
      if (url.pathname === "/mcp" && method === "DELETE") {
        const upstream = await fetch(inspector.serverUrl, {
          method: "DELETE",
          headers: inspector.client.headers({ accept: "application/json" })
        });
        inspector.client.sessionId = undefined;
        return json(response, upstream.status, { status: upstream.status }, cors);
      }
      // ---- extensions
      if (url.pathname === "/handshake" && method === "POST") {
        const result = await inspector.handshake();
        return json(response, 200, { ...result, tools: result.tools.map((t) => t.name) }, cors);
      }
      if (url.pathname === "/drive" && method === "POST") {
        const body = JSON.parse((await readBody(request)) || "{}");
        const script = body.script ?? body.utterance;
        if (!script) return json(response, 400, { error: "script (path or object) or utterance required" }, cors);
        const result = await inspector.drive({
          script: typeof body.utterance === "string" ? { turns: [{ say: body.utterance, tool: body.tool ?? null, args: body.args, expect: body.expect ?? {} }] } : script,
          scriptLabel: body.label,
          brain: body.brain ?? "none",
          model: body.model
        });
        return json(response, 200, { summary: result.summary, turns: result.turns.length, warnings: result.warnings }, cors);
      }
      if (url.pathname === "/link" && method === "POST") {
        const body = JSON.parse((await readBody(request)) || "{}");
        if (!onLink) return json(response, 501, { error: "linking not configured (ALEXA_CLIENT_ID/ALEXA_CLIENT_SECRET)" }, cors);
        const { authorizeUrl } = await onLink(body);
        return json(response, 202, { status: "pending", authorizeUrl }, cors);
      }
      if (url.pathname === "/verdict" && method === "POST")
        return json(response, 200, inspector.evaluateVerdict(), cors);
      if (url.pathname === "/visual" && method === "POST") {
        if (!onVisual) return json(response, 501, { error: "visual mode unavailable" }, cors);
        return json(response, 200, await onVisual(), cors);
      }
      if (url.pathname === "/finish" && method === "POST")
        return json(response, 200, inspector.finish(), cors);
      if (url.pathname === "/recording") {
        const path = join(inspector.recorder.outDir, "events.jsonl");
        response.writeHead(200, { "content-type": "application/x-ndjson", ...cors });
        return response.end(existsSync(path) ? readFileSync(path) : "");
      }
      if (url.pathname === "/widget" && method === "GET") {
        // The latest widget HTML read for a tool (visual mode), served for the device frame.
        const file = join(inspector.recorder.outDir, "widgets", `${url.searchParams.get("tool")}.html`);
        if (!existsSync(file)) return response.writeHead(404, cors).end("no widget");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", ...cors });
        return response.end(readFileSync(file));
      }
      return json(response, 404, { error: "not found" }, cors);
    } catch (error) {
      const message = inspector.fail(url.pathname, error);
      return json(response, 500, { error: message }, cors);
    }
  });
  server.keepAliveTimeout = 65_000;
  return server;
}

/** POST /mcp: forward the client's JSON-RPC body, inject the Alexa+ headers, record, unwrap SSE on request. */
async function mcp(request, response, inspector, cors) {
  const text = await readBody(request);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json(response, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, cors);
  }
  const accept = request.headers.accept ?? "";
  const wantsJson = accept.includes("application/json") && !accept.includes("text/event-stream");
  const ownAuth = request.headers.authorization;
  const outcome = await inspector.client.send(body, {
    auth: !ownAuth,
    accept: "application/json, text/event-stream",
    extra: ownAuth ? { authorization: ownAuth } : {},
    origin: "proxy"
  });
  if (outcome.failure) return json(response, 502, { error: outcome.failure }, cors);
  const headers = { ...cors, ...outcome.headers, "x-inspector-ms": String(outcome.ms) };
  if (wantsJson && outcome.contentType.includes("text/event-stream")) {
    const messages = parseRpcMessages(outcome.text, outcome.contentType);
    const first = Array.isArray(body) ? body : [body];
    const wanted = messages.filter((m) => m && ("result" in m || "error" in m));
    const picked = first.length > 1 ? wanted : (wanted.find((m) => m.id === first[0]?.id) ?? wanted.at(-1) ?? null);
    response.writeHead(outcome.status, { ...headers, "content-type": "application/json" });
    return response.end(JSON.stringify(picked));
  }
  response.writeHead(outcome.status, {
    ...headers,
    "content-type": outcome.contentType || "application/json"
  });
  response.end(outcome.text);
}

/** GET /mcp: the server-to-client stream (a stateless server answers 405). */
async function mcpGet(request, response, inspector, cors) {
  const upstream = await fetch(inspector.serverUrl, {
    method: "GET",
    headers: inspector.client.headers({ accept: "text/event-stream" })
  });
  response.writeHead(upstream.status, {
    ...cors,
    "content-type": upstream.headers.get("content-type") ?? "text/plain"
  });
  if (!upstream.body) return response.end();
  for await (const chunk of upstream.body) response.write(chunk);
  response.end();
}

/** GET /events: SSE with a state snapshot first, then every inspector event. */
function events(request, response, inspector, cors) {
  response.writeHead(200, {
    ...cors,
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive"
  });
  response.write(`event: state\ndata: ${JSON.stringify(inspector.state())}\n\n`);
  const listener = (event) => response.write(`event: ${event.type}\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
  inspector.on("event", listener);
  const beat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
  request.on("close", () => {
    clearInterval(beat);
    inspector.off("event", listener);
  });
}

/** The UI: static files from ui/, with config.js telling the page where the proxy is. */
export function createUiServer({ serverPort = 6277 } = {}) {
  return createServer((request, response) => {
    if (!isLoopback(request.socket)) return response.writeHead(403).end("localhost only");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/config.js") {
      response.writeHead(200, { "content-type": MIME[".js"] });
      return response.end(`window.INSPECTOR_API = "http://127.0.0.1:${serverPort}";\n`);
    }
    const name = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = resolve(UI_DIR, `.${name}`);
    if (!file.startsWith(UI_DIR) || !existsSync(file)) return response.writeHead(404).end("not found");
    response.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
}

export function listen(server, port, host = "127.0.0.1") {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListen(server.address().port));
  });
}
