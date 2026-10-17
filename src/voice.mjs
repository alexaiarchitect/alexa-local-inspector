// Voice rules of the Alexa+ MCP toolkit, applied to one observed turn:
// at most five options, no identifiers spoken, under 30 s of speech, the
// 500 ms round-trip budget, and a bare 401 when the account is not linked.

export const DEFAULTS = { maxOptions: 5, maxMs: 500, maxSeconds: 30 };
/** Speaking rate used to estimate how long an answer takes to say (≈150 wpm). */
export const WORDS_PER_SECOND = 2.5;

function lookup(object, path) {
  return path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
}

/**
 * Replace `{{name.path}}` in strings of `value` with values from `scope`
 * (`prev` = the last tool result's structuredContent, or a turn id). A
 * string that is exactly one placeholder takes the value's own type.
 */
export function substitute(value, scope) {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([\w-]+)((?:\.[\w-]+)*)\s*\}\}$/u.exec(value);
    if (whole) {
      const found = lookup(scope[whole[1]], whole[2].slice(1));
      if (found === undefined) throw new Error(`unresolved placeholder ${value}`);
      return found;
    }
    return value.replace(/\{\{\s*([\w-]+)((?:\.[\w-]+)*)\s*\}\}/gu, (match, name, path) => {
      const found = lookup(scope[name], path.slice(1));
      if (found === undefined) throw new Error(`unresolved placeholder ${match}`);
      return String(found);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, scope));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, scope)]));
  return value;
}

/** What a speaker says for a tool result: its first text content, without markup. */
export function speakable(result) {
  const text =
    (result?.content ?? []).find((item) => item?.type === "text")?.text ??
    result?.structuredContent?.speech ??
    "";
  return text
    .replace(/<[^>]+>/gu, "")
    .replace(/[*_`#]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function speakingSeconds(text) {
  const words = text.split(/\s+/u).filter(Boolean).length;
  return Math.round((words / WORDS_PER_SECOND) * 10) / 10;
}

/** How many options a voice answer offers: the longest list in its structured data. */
export function optionCount(structured) {
  const data = structured?.data;
  if (!data || typeof data !== "object") return 0;
  return Math.max(
    0,
    ...["categories", "entries", "options", "items"]
      .map((key) => data[key])
      .filter(Array.isArray)
      .map((list) => list.length)
  );
}

export const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
export const TOKENISH = /\b[A-Za-z0-9_-]{32,}\b/u;

/**
 * Check one observed turn against its `expect` plus the voice defaults.
 * Returns [{ check, ok, detail }]. Pure.
 */
export function checkExpectations(expect = {}, observed, defaults = DEFAULTS) {
  const checks = [];
  const add = (check, ok, detail) => checks.push({ check, ok: Boolean(ok), detail });
  const speech = observed.speech ?? "";
  const folded = speech.toLowerCase();
  const list = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

  if (expect.status !== undefined)
    add("status", observed.status === expect.status, `HTTP ${observed.status}`);
  if (expect.noWwwAuthenticate)
    add(
      "bare 401",
      !observed.wwwAuthenticate,
      observed.wwwAuthenticate
        ? `WWW-Authenticate: ${observed.wwwAuthenticate}`
        : "no WWW-Authenticate"
    );
  if (observed.tool) {
    const wantError = expect.isError ?? false;
    add(
      wantError ? "isError" : "no error",
      Boolean(observed.isError) === wantError,
      `isError=${Boolean(observed.isError)}`
    );
  }
  if (expect.tool !== undefined)
    add("tool chosen", observed.tool === expect.tool, `${observed.tool ?? "none"}`);
  for (const text of list(expect.contains))
    add(`says "${text}"`, folded.includes(String(text).toLowerCase()), "");
  for (const text of list(expect.notContains))
    add(`never says "${text}"`, !folded.includes(String(text).toLowerCase()), "");
  if (expect.hasNextPage !== undefined)
    add(
      expect.hasNextPage ? "offers more" : "last page",
      Boolean(observed.nextPageToken) === expect.hasNextPage,
      observed.nextPageToken ? "next_page_token present" : "no next_page_token"
    );
  if (expect.toolsListed !== undefined)
    add("tools listed", observed.toolsListed === expect.toolsListed, `${observed.toolsListed}`);
  if (observed.tool || speech) {
    const maxOptions = expect.maxOptions ?? defaults.maxOptions;
    add(
      `≤ ${maxOptions} options`,
      (observed.options ?? 0) <= maxOptions,
      `${observed.options ?? 0}`
    );
    const maxSeconds = expect.maxSeconds ?? defaults.maxSeconds;
    add(
      `≤ ${maxSeconds} s spoken`,
      speakingSeconds(speech) <= maxSeconds,
      `${speakingSeconds(speech)} s`
    );
    add("no ids spoken", !UUID.test(speech) && !TOKENISH.test(speech), "");
  }
  if (observed.ms !== undefined && (observed.tool || expect.maxMs !== undefined)) {
    const maxMs = expect.maxMs ?? defaults.maxMs;
    add(`≤ ${maxMs} ms`, observed.ms <= maxMs, `${observed.ms} ms`);
  }
  return checks;
}

export function percentile(values, p) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function summarize(turns) {
  const ms = turns.flatMap((t) => t.calls.filter((c) => c.auth !== false).map((c) => c.ms));
  const passed = turns.filter((t) => t.pass).length;
  const longest = turns.reduce((a, t) => (t.chars > a.chars ? t : a), { chars: 0, seconds: 0 });
  return {
    turns: turns.length,
    passed,
    calls: ms.length,
    p50Ms: percentile(ms, 50) ?? 0,
    p95Ms: percentile(ms, 95) ?? 0,
    maxMs: ms.length ? Math.max(...ms) : 0,
    longestChars: longest.chars,
    longestSeconds: longest.seconds,
    verdict: passed === turns.length && turns.length > 0 ? "PASS" : "FAIL"
  };
}
