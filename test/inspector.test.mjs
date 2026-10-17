import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFakeServer } from "./fake-server.mjs";
import { Inspector } from "../src/inspector.mjs";
import { createProxyServer, listen } from "../src/proxy.mjs";
import { evaluate } from "../src/verdict.mjs";

const script = {
  locale: "en-US",
  turns: [
    { say: "what am I tracking", tool: "find_categories", args: {}, expect: { contains: "Sleep", hasNextPage: true } },
    { say: "More.", tool: "find_categories", args: { page_token: "{{prev.next_page_token}}" }, expect: { contains: "Reading", hasNextPage: false } },
    { id: "sleep", say: "log 7 hours of sleep", tool: "log_entry", args: { category: "sleep", values: { hours: "7" } }, expect: { contains: "Should I save it?" } },
    { say: "Yes.", tool: "confirm_entry", args: { entry_id: "{{sleep.data.entry_id}}", category: "Sleep" }, expect: { contains: "Saved to Sleep" } },
    { say: "No.", tool: null, reply: "Okay.", expect: {} },
    { say: "unlinked", auth: "none", tool: "find_categories", args: {}, reply: "Link your account.", expect: { status: 401, noWwwAuthenticate: true } }
  ]
};

test("inspector: handshake, scripted drive, verdict and files", async () => {
  const fake = await startFakeServer();
  const outDir = mkdtempSync(join(tmpdir(), "inspector-"));
  const inspector = new Inspector({ serverUrl: fake.url, token: fake.token, tokenSource: "test", outDir, locale: "es-ES" });
  await inspector.start();
  assert.equal(inspector.status, "ok");
  assert.equal(inspector.metadata.prm.resource, fake.url);
  assert.ok(inspector.metadata.as.token_endpoint);

  const hs = await inspector.handshake();
  assert.equal(hs.protocolVersion, "2025-11-25");
  assert.equal(hs.tools.length, 3);
  assert.equal(inspector.session.handshake.steps.length, 3);
  await inspector.listTools();
  assert.equal(inspector.toolsStable, true);

  const conversation = await inspector.drive({ script, scriptLabel: "inline" });
  assert.equal(conversation.summary.turns, 6);
  assert.equal(conversation.summary.verdict, "PASS", JSON.stringify(conversation.turns.filter((t) => !t.pass).map((t) => t.checks), null, 1));
  // locale of the script was sent as Accept-Language, then restored
  const lastCall = fake.calls.filter((c) => c.method === "tools/call").at(-1);
  assert.equal(lastCall.headers["accept-language"], "en-US");
  assert.equal(inspector.client.locale, "es-ES");
  // page token redacted in the published turn
  assert.match(conversation.turns[1].calls[0].args.page_token, /^<page_token 255 chars>$/u);

  const verdict = inspector.evaluateVerdict();
  const failed = verdict.rules.filter((r) => r.status === "FAIL");
  assert.deepEqual(failed, [], JSON.stringify(failed));
  assert.ok(["CERTIFIED", "CONDITIONAL"].includes(verdict.verdict));
  const { sessionDir } = inspector.finish();
  for (const name of ["events.jsonl", "tools.json", "tool-result.json", "state.json", "inspection-summary.json", "certification-verdict.json", "transcript.md"])
    assert.ok(existsSync(join(outDir, name)), name);
  assert.ok(existsSync(join(sessionDir, "transcript.md")));
  const transcript = readFileSync(join(outDir, "transcript.md"), "utf8");
  assert.match(transcript, /## Conversation/u);
  assert.doesNotMatch(transcript, new RegExp(fake.token, "u"));
  assert.doesNotMatch(readFileSync(join(outDir, "events.jsonl"), "utf8"), new RegExp(fake.token, "u"));
  await fake.close();
});

test("proxy: forwards with injected headers, unwraps SSE on Accept: application/json, records", async () => {
  const fake = await startFakeServer();
  const outDir = mkdtempSync(join(tmpdir(), "inspector-"));
  const inspector = new Inspector({ serverUrl: fake.url, token: fake.token, outDir, locale: "en-US" });
  await inspector.start();
  const proxy = createProxyServer(inspector, {});
  const port = await listen(proxy, 0);
  const base = `http://127.0.0.1:${port}`;

  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.status, "ok");

  const init = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) });
  assert.equal(init.headers.get("content-type"), "application/json");
  const initJson = await init.json();
  assert.equal(initJson.result.serverInfo.name, "Fake Vault");
  const upstream = fake.calls.find((c) => c.method === "initialize");
  assert.equal(upstream.headers["mcp-protocol-version"], "2025-11-25");
  assert.equal(upstream.headers["accept-language"], "en-US");
  assert.equal(upstream.auth, true);

  const raw = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) });
  assert.match(raw.headers.get("content-type"), /text\/event-stream/u);
  await raw.text();
  assert.equal(inspector.tools.length, 3);

  const noAuth = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer wrong" }, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }) });
  assert.equal(noAuth.status, 401);

  const state = await (await fetch(`${base}/state`)).json();
  assert.equal(state.calls.length, 3);
  assert.equal(state.tokenPresent, true);
  assert.equal(JSON.stringify(state).includes(fake.token), false);

  const get = await fetch(`${base}/mcp`);
  assert.equal(get.status, 405);

  const drive = await (await fetch(`${base}/drive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ utterance: "what am I tracking", tool: "find_categories", args: {}, expect: { contains: "Sleep" } }) })).json();
  assert.equal(drive.summary.verdict, "PASS");
  const verdict = await (await fetch(`${base}/verdict`, { method: "POST" })).json();
  assert.ok(verdict.rules.length > 5);

  proxy.close();
  await fake.close();
});

test("verdict flags the failures", () => {
  const verdict = evaluate({
    serverUrl: "https://x/mcp",
    session: { requestedProtocolVersion: "2025-11-25", protocolVersion: "2025-11-25" },
    tools: [{ name: "Bad Name", description: "click the button", inputSchema: { type: "string" } }],
    toolsStable: false,
    calls: [{ method: "tools/call", auth: true, ms: 900, status: 500 }],
    conversation: { turns: [{ n: 1, pass: false, alexaSays: "id 3f1c2a4e-1111-4222-8333-444455556666", calls: [{ options: 9, auth: false, status: 401, wwwAuthenticate: "Bearer" }], checks: [{ check: "x", ok: false }] }] },
    metadata: { prm: { resource: "https://other/mcp" }, as: { grant_types_supported: ["authorization_code"], code_challenge_methods_supported: [] } }
  });
  assert.equal(verdict.verdict, "NOT_CERTIFIED");
  const failed = verdict.rules.filter((r) => r.status === "FAIL").map((r) => r.id);
  for (const id of ["ALX-TOOLS-STABLE", "ALX-TOOL-NAMES", "ALX-INPUT-SCHEMA", "ALX-SCRIPT", "ALX-MAX-OPTIONS", "ALX-NO-IDS", "ALX-BARE-401", "ALX-LATENCY", "ALX-NO-5XX", "ALX-PRM", "ALX-AS-METADATA"])
    assert.ok(failed.includes(id), id);
});
