// Streamable HTTP client that talks to an MCP server the way the Alexa+ MCP
// client does: JSON-RPC POSTs with `MCP-Protocol-Version`, `Accept:
// application/json, text/event-stream`, a Bearer token and `Accept-Language`.
// Every exchange is reported to `onCall` so the inspector can record it.

export const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
export const CLIENT_INFO = {
  name: "alexa-local-inspector",
  title: "Alexa local inspector (simulated Alexa+ client)",
  version: "0.1.0"
};

/** Split an SSE body into events ({ event, id, data }); `data` lines are joined with "\n". */
export function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const event = { event: "message", data: "" };
    const data = [];
    for (const line of block.split(/\r?\n/u)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "event") event.event = value;
      else if (field === "id") event.id = value;
    }
    if (data.length) events.push({ ...event, data: data.join("\n") });
  }
  return events;
}

/** Every JSON-RPC message in a JSON or SSE body, in order. */
export function parseRpcMessages(text, contentType = "") {
  if (!text || !text.trim()) return [];
  if (contentType.includes("text/event-stream")) {
    return parseSse(text)
      .filter((event) => event.event === "message")
      .map((event) => JSON.parse(event.data));
  }
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * The JSON-RPC response to request `id` from a JSON or SSE body (the server
 * may send notifications before it on an SSE stream). `undefined` for an
 * empty body (202 Accepted).
 */
export function parseRpcResponse(text, contentType = "", id) {
  const messages = parseRpcMessages(text, contentType);
  if (!messages.length) return undefined;
  const responses = messages.filter((m) => m && ("result" in m || "error" in m));
  if (contentType.includes("text/event-stream"))
    return (id === undefined ? undefined : responses.find((m) => m.id === id)) ?? responses.at(-1);
  if (messages.length > 1) return messages.find((m) => m.id === id) ?? messages[0];
  return messages[0];
}

const SECRET_KEYS = /^(authorization|access_token|refresh_token|id_token|client_secret|code_verifier|password)$/iu;

/** Deep copy with secrets removed and long strings shortened (a page token is 255 chars). */
export function redact(value, { maxString = 48, key = "" } = {}) {
  if (SECRET_KEYS.test(key)) return "<redacted>";
  if (typeof value === "string")
    return value.length > maxString ? `<${key || "string"} ${value.length} chars>` : value;
  if (Array.isArray(value)) return value.map((item) => redact(item, { maxString }));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redact(v, { maxString, key: k })])
    );
  return value;
}

export class McpClient {
  constructor({
    server,
    token,
    locale = "en-US",
    metaLocale = false,
    protocolVersion = DEFAULT_PROTOCOL_VERSION,
    clientInfo = CLIENT_INFO,
    timeoutMs = 30_000,
    onCall
  }) {
    this.server = server;
    this.token = token;
    this.locale = locale;
    this.metaLocale = metaLocale;
    this.protocolVersion = protocolVersion;
    this.clientInfo = clientInfo;
    this.timeoutMs = timeoutMs;
    this.onCall = onCall;
    this.nextId = 1;
    this.seq = 0;
    this.sessionId = undefined;
  }

  headers({ auth = true, accept = "application/json, text/event-stream", extra = {} } = {}) {
    return {
      "content-type": "application/json",
      accept,
      "mcp-protocol-version": this.protocolVersion,
      "accept-language": this.locale,
      "user-agent": `${this.clientInfo.name}/${this.clientInfo.version}`,
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(auth && this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra
    };
  }

  /**
   * Send one already-built JSON-RPC message (or batch) and return the raw
   * outcome. Used by `post` and by the proxy, which forwards client bodies.
   */
  async send(body, { auth = true, accept, extra, origin = "client" } = {}) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    const message = typeof body === "string" ? safeJson(body) : body;
    const first = Array.isArray(message) ? message[0] : message;
    const started = performance.now();
    const ts = new Date().toISOString();
    let response;
    let responseText = "";
    let failure;
    try {
      response = await fetch(this.server, {
        method: "POST",
        headers: this.headers({ auth, accept, extra }),
        body: text,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      responseText = await response.text();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    const ms = Math.round((performance.now() - started) * 10) / 10;
    const contentType = response?.headers.get("content-type") ?? "";
    let parsed;
    try {
      parsed = parseRpcResponse(responseText, contentType, first?.id);
    } catch {
      parsed = undefined;
    }
    const session = response?.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    const outcome = {
      seq: ++this.seq,
      ts,
      origin,
      method: first?.method,
      name: first?.method === "tools/call" ? first?.params?.name : undefined,
      id: first?.id,
      status: response?.status ?? 0,
      contentType,
      headers: response ? headerSubset(response.headers) : {},
      wwwAuthenticate: response?.headers.get("www-authenticate") ?? undefined,
      message: parsed,
      text: responseText,
      raw: parsed ? undefined : responseText.slice(0, 300),
      failure,
      ms,
      auth: Boolean(auth && this.token),
      sessionId: this.sessionId
    };
    this.onCall?.({
      ...outcome,
      request: redact(message),
      response: redact(parsed),
      isError: Boolean(parsed?.result?.isError || parsed?.error || failure)
    });
    return outcome;
  }

  /** POST one JSON-RPC message; returns status, headers, parsed message and wall-clock ms. */
  async post(method, params, { notification = false, auth = true, origin = "inspector" } = {}) {
    const id = notification ? undefined : this.nextId++;
    const body = {
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method,
      ...(params === undefined ? {} : { params })
    };
    return this.send(body, { auth, origin });
  }

  async callTool(name, args, options = {}) {
    const params = {
      name,
      arguments: args ?? {},
      ...(this.metaLocale ? { _meta: { locale: this.locale } } : {})
    };
    return this.post("tools/call", params, options);
  }

  async readResource(uri, options = {}) {
    return this.post("resources/read", { uri }, options);
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function headerSubset(headers) {
  const keep = [
    "content-type",
    "mcp-session-id",
    "mcp-protocol-version",
    "www-authenticate",
    "cache-control",
    "x-amzn-requestid",
    "x-amzn-trace-id",
    "x-amz-apigw-id"
  ];
  const out = {};
  for (const name of keep) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

/** The legacy (2025-11-25) handshake Alexa+ performs, then tools/list. */
export async function handshake(client) {
  const steps = [];
  const init = await client.post("initialize", {
    protocolVersion: client.protocolVersion,
    capabilities: {},
    clientInfo: client.clientInfo
  });
  steps.push({ step: "initialize", status: init.status, ms: init.ms });
  const result = init.message?.result;
  if (!result) {
    const reason =
      init.message?.error?.message ?? init.failure ?? init.raw ?? `HTTP ${init.status}`;
    throw new Error(`initialize failed: ${reason}`);
  }
  const initialized = await client.post("notifications/initialized", undefined, {
    notification: true
  });
  steps.push({ step: "notifications/initialized", status: initialized.status, ms: initialized.ms });
  const list = await client.post("tools/list", {});
  steps.push({ step: "tools/list", status: list.status, ms: list.ms });
  const tools = list.message?.result?.tools ?? [];
  return {
    steps,
    totalMs: Math.round(steps.reduce((sum, s) => sum + s.ms, 0) * 10) / 10,
    requestedProtocolVersion: client.protocolVersion,
    protocolVersion: result.protocolVersion,
    serverInfo: result.serverInfo ?? {},
    capabilities: Object.keys(result.capabilities ?? {}),
    instructions: result.instructions,
    sessionId: client.sessionId,
    tools
  };
}
