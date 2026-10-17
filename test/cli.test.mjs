import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.mjs";
import { ClaudeBrain, claudeTools } from "../src/brain-claude.mjs";

test("parseArgs: commands, defaults and validation", () => {
  const serve = parseArgs(["https://h/mcp"]);
  assert.equal(serve.command, "serve");
  assert.equal(serve.serverPort, 6277);
  assert.equal(serve.clientPort, 6274);
  const drive = parseArgs(["drive", "http://127.0.0.1:8787/mcp", "--script", "s.json", "--brain", "claude", "--no-open", "--server-port", "7000"]);
  assert.equal(drive.command, "drive");
  assert.equal(drive.script, "s.json");
  assert.equal(drive.serverPort, 7000);
  assert.equal(drive.open, false);
  assert.throws(() => parseArgs(["drive", "https://h/mcp"]), /--script/u);
  assert.throws(() => parseArgs([]), /server URL/u);
  assert.throws(() => parseArgs(["https://h/mcp", "--brain", "bedrock"]), /--brain/u);
  assert.throws(() => parseArgs(["https://h/mcp", "--locale", "en"]), /--locale/u);
  assert.equal(parseArgs(["report", "--out-dir", "/tmp/x"]).command, "report");
});

test("claude brain: tool definitions and a mocked tool-use round trip", async () => {
  const tools = [{ name: "find_categories", description: "Lists categories", inputSchema: { type: "object" } }];
  assert.equal(claudeTools(tools)[0].input_schema.type, "object");
  let round = 0;
  const fetchImpl = async (url, init) => {
    round += 1;
    const body = JSON.parse(init.body);
    assert.equal(init.headers["x-api-key"], "k");
    const content = round === 1
      ? [{ type: "tool_use", id: "tu1", name: "find_categories", input: {} }]
      : [{ type: "text", text: "You track Sleep and Water." }];
    if (round === 2) assert.equal(body.messages.at(-1).content[0].type, "tool_result");
    return { ok: true, status: 200, json: async () => ({ content }) };
  };
  const brain = new ClaudeBrain({ locale: "en-US", tools, env: { ANTHROPIC_API_KEY: "k" }, fetchImpl });
  const client = { callTool: async (name, args) => ({ message: { result: { content: [{ type: "text", text: "Sleep, Water" }], structuredContent: { ok: true } } }, status: 200, ms: 5 }) };
  const outcome = await brain.turn("what do I track", client);
  assert.equal(outcome.calls.length, 1);
  assert.equal(outcome.alexaSays, "You track Sleep and Water.");
});
