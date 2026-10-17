import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExpectations, optionCount, percentile, speakable, speakingSeconds, substitute, summarize } from "../src/voice.mjs";

test("speakable strips markup and optionCount finds the longest list", () => {
  assert.equal(speakable({ content: [{ type: "text", text: "**Hi** <b>there</b>\n now" }] }), "Hi there now");
  assert.equal(speakable({ structuredContent: { speech: "fallback" } }), "fallback");
  assert.equal(optionCount({ data: { categories: [1, 2, 3], entries: [1] } }), 3);
  assert.equal(optionCount({}), 0);
});

test("substitute resolves placeholders with their own type and throws when missing", () => {
  const scope = { prev: { next_page_token: "abc", n: 2 }, sleep: { data: { entry_id: "id-1" } } };
  assert.deepEqual(substitute({ page_token: "{{prev.next_page_token}}", n: "{{prev.n}}", s: "x{{sleep.data.entry_id}}y" }, scope), { page_token: "abc", n: 2, s: "xid-1y" });
  assert.throws(() => substitute("{{prev.missing}}", scope), /unresolved/u);
});

test("checkExpectations applies the voice rules", () => {
  const observed = { speech: "You have 5 categories. Say 'more'.", tool: "find_categories", status: 200, isError: false, nextPageToken: "x", options: 5, ms: 42 };
  const checks = checkExpectations({ contains: ["5 categories", "say 'more'"], notContains: "Reading", hasNextPage: true, maxMs: 500 }, observed);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));
  const bad = checkExpectations({ hasNextPage: false }, { ...observed, speech: "id 3f1c2a4e-1111-4222-8333-444455556666", options: 7, ms: 900 });
  const failed = bad.filter((c) => !c.ok).map((c) => c.check);
  assert.deepEqual(failed, ["last page", "≤ 5 options", "no ids spoken", "≤ 500 ms"]);
});

test("bare 401 check and speaking time", () => {
  const checks = checkExpectations({ status: 401, noWwwAuthenticate: true }, { status: 401, wwwAuthenticate: "Bearer resource_metadata=x", speech: "" });
  assert.equal(checks.find((c) => c.check === "bare 401").ok, false);
  assert.equal(speakingSeconds("one two three four five"), 2);
});

test("percentile and summarize", () => {
  assert.equal(percentile([5, 1, 9, 3], 50), 3);
  assert.equal(percentile([5, 1, 9, 3], 95), 9);
  const s = summarize([
    { pass: true, chars: 10, seconds: 1, calls: [{ ms: 10, auth: true }, { ms: 30, auth: false }] },
    { pass: false, chars: 20, seconds: 2, calls: [{ ms: 20, auth: true }] }
  ]);
  assert.equal(s.calls, 2);
  assert.equal(s.maxMs, 20);
  assert.equal(s.verdict, "FAIL");
  assert.equal(s.longestChars, 20);
});
