// An in-process stand-in for an Alexa-profile MCP server: bare 401 without a
// token, legacy handshake, six-ish voice tools, SSE-framed responses, PRM and
// RFC 8414 metadata, and a fake authorization server for the link flow.
import { createServer } from "node:http";

export function startFakeServer({ sse = true, token = "t0k3n" } = {}) {
  const calls = [];
  const tools = [
    { name: "find_categories", title: "Find my categories", description: "Says which categories you keep, five at a time.", inputSchema: { type: "object", properties: { page_token: { type: "string" } } } },
    { name: "log_entry", title: "Log an entry", description: "Reads a preview of the entry back and asks whether to save it.", inputSchema: { type: "object", properties: { category: { type: "string" }, values: { type: "object" } }, required: ["category", "values"] } },
    { name: "confirm_entry", title: "Save a confirmed entry", description: "Saves an entry after the user said yes to the preview.", inputSchema: { type: "object", properties: { entry_id: { type: "string" } }, required: ["entry_id"] }, _meta: { ui: { resourceUri: "ui://fake/confirm.html" } } }
  ];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let base;
    const json = (status, body, headers = {}) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/health") return json(200, { status: "ok" });
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
      base = `http://127.0.0.1:${server.address().port}`;
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [`${base}/mcp/categories.read`, `${base}/mcp/records.write`], bearer_methods_supported: ["header"] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      base = `http://127.0.0.1:${server.address().port}`;
      return json(200, { issuer: base, authorization_endpoint: `${base}/oauth2/authorize`, token_endpoint: `${base}/oauth2/token`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"], code_challenge_methods_supported: ["S256"], scopes_supported: [`${base}/mcp/categories.read`] });
    }
    if (url.pathname === "/oauth2/token" && request.method === "POST") {
      const body = new URLSearchParams(await read(request));
      calls.push({ method: "oauth2/token", grant: body.get("grant_type"), resource: body.get("resource"), verifier: Boolean(body.get("code_verifier")), auth: request.headers.authorization });
      if (body.get("code") !== "good-code") return json(400, { error: "invalid_grant" });
      return json(200, { access_token: "eyJhbGciOiJub25lIn0." + Buffer.from(JSON.stringify({ iss: "fake", client_id: "c1", scope: "categories.read", token_use: "access" })).toString("base64url") + ".", token_type: "Bearer", expires_in: 3600, scope: "categories.read" });
    }
    if (url.pathname !== "/mcp") return json(404, { error: "not found" });
    if (request.method === "GET") return json(405, { error: "stateless" });
    if (request.method === "DELETE") return json(405, { error: "stateless" });
    const text = await read(request);
    const message = JSON.parse(text);
    const auth = request.headers.authorization;
    calls.push({ method: message.method, name: message.params?.name, headers: request.headers, auth: Boolean(auth), meta: message.params?._meta });
    if (auth !== `Bearer ${token}`) return json(401, { error: { code: "AUTH_REQUIRED", message: "A bearer access token is required" } });
    let result;
    if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Fake Vault", title: "Fake Vault", version: "0.0.1" } };
    else if (message.method === "notifications/initialized") { response.writeHead(202).end(); return; }
    else if (message.method === "tools/list") result = { tools };
    else if (message.method === "resources/read") result = { contents: [{ uri: message.params.uri, mimeType: "text/html;profile=mcp-app", text: "<!doctype html><html><body><button style='width:40px;height:20px'>ok</button><script>parent.postMessage({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{}},'*')</script></body></html>" }] };
    else if (message.method === "tools/call") {
      const { name, arguments: args } = message.params;
      const lang = (request.headers["accept-language"] ?? "en-US").startsWith("es") ? "es" : "en";
      if (name === "find_categories") {
        const page2 = Boolean(args?.page_token);
        const speech = page2 ? (lang === "es" ? "Más categorías: Medicación y Lectura. Eso es todo." : "More categories: Medication and Reading. That's all of them.") : (lang === "es" ? "Tienes 5 categorías en esta página: Sueño, Entrenamientos, Ánimo, Agua y Peso. Di 'más' para oír las siguientes." : "You have 5 categories on this page: Sleep, Workouts, Mood, Water, and Weight. Say 'more' to hear the next ones.");
        const data = { categories: page2 ? ["Medication", "Reading"] : ["Sleep", "Workouts", "Mood", "Water", "Weight"] };
        result = { content: [{ type: "text", text: speech }], structuredContent: { ok: true, speech, data, ...(page2 ? {} : { next_page_token: "x".repeat(255) }) } };
      } else if (name === "log_entry") {
        const speech = `${args.category}: ${JSON.stringify(args.values)}. Should I save it?`;
        result = { content: [{ type: "text", text: speech }], structuredContent: { ok: true, speech, data: { entry_id: "3f1c2a4e-1111-4222-8333-444455556666" } } };
      } else if (name === "confirm_entry") {
        result = { content: [{ type: "text", text: `Saved to ${args.category ?? "it"}.` }], structuredContent: { ok: true, speech: "Saved." } };
      } else {
        result = { isError: true, content: [{ type: "text", text: "I couldn't find that." }], structuredContent: { ok: false, speech: "I couldn't find that.", error: { code: "NOT_FOUND" } } };
      }
    } else return json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    const payload = { jsonrpc: "2.0", id: message.id, result };
    if (sse) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "hello" } })}\n\nevent: message\ndata: ${JSON.stringify(payload)}\n\n`);
    } else json(200, payload);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}/mcp`, token, calls, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function read(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
