import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRpcMessages, parseRpcResponse, parseSse, redact } from "../src/mcp-client.mjs";

test("parseSse splits events and joins data lines", () => {
  const events = parseSse('event: message\nid: 1\ndata: {"a":\ndata: 1}\n\n: comment\n\ndata: {"b":2}\n\n');
  assert.equal(events.length, 2);
  assert.equal(events[0].data, '{"a":\n1}');
  assert.equal(events[0].id, "1");
  assert.equal(events[1].event, "message");
});

test("parseRpcResponse picks the response to the request id after notifications", () => {
  const body =
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n';
  assert.deepEqual(parseRpcResponse(body, "text/event-stream", 7).result, { ok: true });
  assert.equal(parseRpcMessages(body, "text/event-stream").length, 2);
});

test("parseRpcResponse handles JSON, batches and empty bodies", () => {
  assert.equal(parseRpcResponse("", "application/json", 1), undefined);
  assert.equal(parseRpcResponse('{"jsonrpc":"2.0","id":1,"result":1}', "application/json", 1).result, 1);
  assert.equal(parseRpcResponse('[{"id":2,"result":2},{"id":3,"result":3}]', "application/json", 3).result, 3);
});

test("redact hides secrets and shortens long strings", () => {
  const out = redact({ authorization: "Bearer abc", page_token: "x".repeat(300), nested: { access_token: "t", ok: "short" } });
  assert.equal(out.authorization, "<redacted>");
  assert.equal(out.page_token, "<page_token 300 chars>");
  assert.equal(out.nested.access_token, "<redacted>");
  assert.equal(out.nested.ok, "short");
});
