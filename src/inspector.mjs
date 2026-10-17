// The inspector: one MCP client, one recorder, one event stream. Everything
// the proxy, the CLI and the UI do goes through here, so a run is recorded
// the same way whichever entry point drove it.
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { handshake, McpClient, redact } from "./mcp-client.mjs";
import { DEFAULT_OUT_DIR, Recorder } from "./recorder.mjs";
import { normalizeScript, runScript, summarize } from "./driver.mjs";
import { ClaudeBrain, claudeAvailability } from "./brain-claude.mjs";
import { discover, link } from "./link.mjs";
import { evaluate } from "./verdict.mjs";
import { renderTranscript } from "./transcript.mjs";

export class Inspector extends EventEmitter {
  constructor({
    serverUrl,
    token,
    tokenSource,
    locale = "en-US",
    metaLocale = false,
    protocolVersion,
    outDir = DEFAULT_OUT_DIR,
    verbose = false,
    log = () => {}
  }) {
    super();
    if (!/^https?:\/\//u.test(serverUrl)) throw new Error("server URL must be http:// or https://");
    const host = new URL(serverUrl).hostname;
    if (serverUrl.startsWith("http://") && !["127.0.0.1", "localhost", "::1"].includes(host))
      throw new Error("remote http:// upstreams are rejected; use https:// (http only for loopback)");
    this.serverUrl = serverUrl;
    this.locale = locale;
    this.metaLocale = metaLocale;
    this.verbose = verbose;
    this.log = log;
    this.recorder = new Recorder(outDir);
    this.startedAt = this.recorder.startedAt;
    this.seq = 0;
    this.status = "not-ready";
    this.calls = [];
    this.tools = [];
    this.toolsStable = undefined;
    this.session = undefined;
    this.metadata = undefined;
    this.conversation = undefined;
    this.link = undefined;
    this.verdict = undefined;
    this.screenshots = [];
    this.errors = [];
    this.lastToolResult = undefined;
    this.setToken(token, tokenSource);
    this.client = new McpClient({
      server: serverUrl,
      token,
      locale,
      metaLocale,
      protocolVersion,
      onCall: (record) => this.recordCall(record)
    });
  }

  setToken(token, source) {
    this.token = token;
    this.tokenSource = token ? (source ?? "set") : undefined;
    if (this.client) this.client.token = token;
    this.emitEvent("token", { present: Boolean(token), source: this.tokenSource });
  }

  /** Snapshot without secrets, as served on GET /state and written to state.json. */
  state() {
    return {
      status: this.status,
      startedAt: this.startedAt,
      serverUrl: this.serverUrl,
      locale: this.locale,
      metaLocale: this.metaLocale,
      protocolVersion: this.client.protocolVersion,
      tokenPresent: Boolean(this.token),
      tokenSource: this.tokenSource,
      outDir: this.recorder.outDir,
      sessionDir: this.recorder.sessionDir,
      session: this.session,
      tools: this.tools,
      toolsStable: this.toolsStable,
      metadata: this.metadata,
      calls: this.calls,
      conversation: this.conversation,
      link: this.link,
      verdict: this.verdict,
      screenshots: this.screenshots,
      errors: this.errors
    };
  }

  emitEvent(type, payload) {
    const event = { seq: ++this.seq, ts: new Date().toISOString(), type, ...payload };
    this.recorder?.event(event);
    this.emit("event", event);
    if (this.verbose) this.log(`[${type}] ${JSON.stringify(payload).slice(0, 200)}`);
    return event;
  }

  recordCall(record) {
    const { text, message, ...rest } = record;
    const call = { ...rest, durationMs: rest.ms };
    this.calls.push(call);
    this.emitEvent("call", call);
    const result = message?.result;
    if (record.method === "tools/list" && result?.tools) this.setTools(result.tools);
    if (record.method === "tools/call") {
      this.lastToolResult = { tool: record.name, status: record.status, ms: record.ms, result: message };
      this.recorder.json("tool-result.json", this.lastToolResult);
    }
    if (record.method === "initialize" && result) {
      this.session = {
        requestedProtocolVersion: this.client.protocolVersion,
        protocolVersion: result.protocolVersion,
        serverInfo: result.serverInfo ?? {},
        capabilities: Object.keys(result.capabilities ?? {}),
        instructions: result.instructions,
        sessionId: this.client.sessionId,
        handshake: this.session?.handshake
      };
      this.emitEvent("session", this.session);
    }
    this.snapshot();
  }

  setTools(tools) {
    const previous = JSON.stringify(this.tools);
    const next = JSON.stringify(tools);
    if (this.tools.length) this.toolsStable = previous === next && (this.toolsStable ?? true);
    this.tools = tools;
    this.recorder.json("tools.json", { tools });
    this.emitEvent("tools", { count: tools.length, tools, stable: this.toolsStable });
  }

  snapshot() {
    this.recorder.json("state.json", this.state());
  }

  fail(context, error) {
    const message = error instanceof Error ? error.message : String(error);
    this.errors.push({ context, message, ts: new Date().toISOString() });
    this.emitEvent("error", { context, message });
    return message;
  }

  /** Fetch PRM + AS metadata (non-fatal), then mark the proxy ready. */
  async start() {
    try {
      const found = await discover(this.serverUrl);
      this.metadata = { prm: found.prm, as: found.as, attempts: found.attempts };
      this.emitEvent("metadata", redact(this.metadata, { maxString: 4096 }));
    } catch (error) {
      this.fail("metadata", error);
    }
    this.status = "ok";
    this.emitEvent("status", { status: "ok" });
    this.snapshot();
    return this;
  }

  /** initialize → notifications/initialized → tools/list (recorded through onCall). */
  async handshake() {
    const result = await handshake(this.client);
    this.session = { ...(this.session ?? {}), ...result, handshake: { steps: result.steps, totalMs: result.totalMs } };
    delete this.session.steps;
    delete this.session.totalMs;
    delete this.session.tools;
    this.emitEvent("session", this.session);
    this.snapshot();
    return result;
  }

  /** A second tools/list to prove the listing is stable. */
  async listTools() {
    const list = await this.client.post("tools/list", {});
    return list.message?.result?.tools ?? [];
  }

  /**
   * Drive a conversation. `script` is a path or a script object; `brain` is
   * "none" or "claude". Runs the handshake first if it has not happened.
   */
  async drive({ script, scriptLabel, brain = "none", model } = {}) {
    const loaded = typeof script === "string" ? JSON.parse(readFileSync(resolve(script), "utf8")) : script;
    const normalized = normalizeScript(loaded, this.locale);
    if (!this.session?.protocolVersion) await this.handshake();
    if (this.toolsStable === undefined) await this.listTools();
    const warnings = [];
    if (!this.token) warnings.push("no token: authenticated turns will get 401");
    let brainImpl;
    let brainLabel = "none (scripted turns)";
    if (brain === "claude") {
      const available = claudeAvailability();
      if (available.ok) {
        brainImpl = new ClaudeBrain({ model, locale: normalized.locale, tools: this.tools });
        brainLabel = brainImpl.label;
      } else {
        warnings.push(`--brain claude unavailable (${available.reason}); played the scripted turns instead`);
        brainLabel = "none (claude requested but unavailable)";
      }
    }
    this.conversation = {
      startedAt: new Date().toISOString(),
      locale: normalized.locale,
      script: scriptLabel ?? (typeof script === "string" ? script : "inline"),
      brain: brainLabel,
      warnings,
      turns: [],
      total: normalized.turns.length
    };
    this.emitEvent("conversation", { phase: "start", ...this.conversation });
    const previousLocale = this.client.locale;
    this.client.locale = normalized.locale;
    try {
      await runScript({
        client: this.client,
        script: normalized,
        brain: brainImpl,
        toolsListed: this.tools.length,
        onTurn: (turn, done, total) => {
          this.conversation.turns.push(turn);
          this.emitEvent("turn", { turn, done, total });
          this.snapshot();
        }
      });
    } catch (error) {
      warnings.push(this.fail("drive", error));
    } finally {
      this.client.locale = previousLocale;
    }
    this.conversation.summary = summarize(this.conversation.turns);
    this.conversation.finishedAt = new Date().toISOString();
    this.emitEvent("conversation", { phase: "end", summary: this.conversation.summary });
    this.snapshot();
    return this.conversation;
  }

  /** Account linking; `openUrl` receives the authorize URL. */
  async linkAccount({ clientId, clientSecret, scope, openUrl, tokenFile }) {
    this.link = { status: "pending", startedAt: new Date().toISOString() };
    this.emitEvent("link", this.link);
    try {
      const result = await link({
        resource: this.serverUrl,
        clientId,
        clientSecret,
        scope,
        discovery: this.metadata?.prm && this.metadata?.as ? { prm: this.metadata.prm, as: this.metadata.as } : undefined,
        openUrl,
        tokenFile,
        onEvent: (record) => {
          this.link = { ...this.link, ...record, status: record.phase === "linked" ? "linked" : "pending" };
          this.emitEvent("link", this.link);
        }
      });
      this.setToken(result.accessToken, "account linking");
      this.link = { ...this.link, status: "linked" };
      this.emitEvent("link", this.link);
      this.snapshot();
      return this.link;
    } catch (error) {
      this.link = { ...this.link, status: "failed", error: this.fail("link", error) };
      this.emitEvent("link", this.link);
      this.snapshot();
      throw error;
    }
  }

  evaluateVerdict() {
    this.verdict = evaluate(this.state());
    this.recorder.json("certification-verdict.json", this.verdict);
    this.emitEvent("verdict", this.verdict);
    this.snapshot();
    return this.verdict;
  }

  /** Write the summary, verdict and transcript, then archive the run. */
  finish() {
    if (!this.verdict) this.evaluateVerdict();
    const state = this.state();
    const summary = {
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      server: this.serverUrl,
      protocol: { requested: this.client.protocolVersion, negotiated: this.session?.protocolVersion },
      serverInfo: this.session?.serverInfo,
      tools: this.tools.map((t) => t.name),
      toolCalls: this.calls.filter((c) => c.method === "tools/call").length,
      requests: this.calls.length,
      conversation: this.conversation?.summary,
      link: this.link ? { status: this.link.status, scopesGranted: this.link.scopesGranted } : undefined,
      screenshots: this.screenshots.map((s) => s.file),
      certification: { verdict: this.verdict.verdict, ...this.verdict.counts },
      errors: this.errors
    };
    this.recorder.json("inspection-summary.json", summary);
    this.recorder.text("transcript.md", renderTranscript(state));
    this.snapshot();
    const sessionDir = this.recorder.archive();
    this.emitEvent("finished", { sessionDir, summary });
    return { summary, sessionDir };
  }
}
