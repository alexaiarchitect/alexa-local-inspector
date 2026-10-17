// The voice driver: plays a scripted Alexa+ conversation (each turn names
// the utterance, the tool Alexa+ would pick and its arguments) or lets a
// "brain" pick tools from the utterance, speaks the server's answer, and
// checks every turn against the voice rules. Emits a `turn` event per turn.
import {
  checkExpectations,
  optionCount,
  speakable,
  speakingSeconds,
  substitute,
  summarize
} from "./voice.mjs";
import { redact } from "./mcp-client.mjs";

export function observeCall(tool, args, response, auth) {
  const result = response.message?.result;
  const error = response.message?.error;
  return {
    tool,
    args,
    auth,
    seq: response.seq,
    status: response.status,
    wwwAuthenticate: response.wwwAuthenticate,
    isError: Boolean(result?.isError || error || response.failure),
    speech: result ? speakable(result) : (error?.message ?? response.failure ?? ""),
    structured: result?.structuredContent,
    nextPageToken: result?.structuredContent?.next_page_token,
    options: optionCount(result?.structuredContent),
    ms: response.ms
  };
}

/** A script is `{ locale?, turns: [...] }` or a bare array of turns. */
export function normalizeScript(loaded, fallbackLocale) {
  const script = Array.isArray(loaded) ? { turns: loaded } : { ...loaded };
  if (!Array.isArray(script.turns)) throw new Error("script has no turns[]");
  script.locale ??= fallbackLocale;
  return script;
}

/** One utterance as a one-turn script (free-form, for brain mode or manual turns). */
export function utteranceScript(say, { tool, args, expect, locale } = {}) {
  return { locale, turns: [{ say, tool: tool ?? null, args, expect: expect ?? {} }] };
}

/** Make a turn safe to publish: args and structured data redacted. */
export function publishTurn(turn) {
  return {
    ...turn,
    calls: turn.calls.map(({ structured, nextPageToken, ...call }) => ({
      ...call,
      args: redact(call.args),
      hasNextPage: Boolean(nextPageToken),
      structured: structured ? redact({ ...structured, next_page_token: undefined }) : undefined
    }))
  };
}

/**
 * Run every turn of `script` against `client`. `brain` (optional) picks the
 * tools; without it the script is played deterministically. `onTurn` is
 * called after each turn with the published turn.
 */
export async function runScript({ client, script, brain, toolsListed, onTurn }) {
  const scope = {};
  const turns = [];
  for (const [index, spec] of script.turns.entries()) {
    const turn = { n: index + 1, say: spec.say, calls: [], note: spec.note };
    const started = performance.now();
    try {
      if (brain && spec.auth !== "none") {
        const outcome = await brain.turn(spec.say, client);
        turn.calls = outcome.calls.map((c) => observeCall(c.tool, c.args, c.response, true));
        turn.alexaSays = outcome.alexaSays || turn.calls.at(-1)?.speech || "";
        turn.note = [spec.note, `model ${outcome.modelMs} ms`].filter(Boolean).join("; ");
        turn.modelMs = outcome.modelMs;
      } else if (spec.tool) {
        const auth = spec.auth !== "none";
        const args = substitute(spec.args ?? {}, scope);
        const response = await client.callTool(spec.tool, args, { auth });
        const call = observeCall(spec.tool, args, response, auth);
        turn.calls.push(call);
        turn.alexaSays = auth ? call.speech : (spec.reply ?? call.speech);
      } else {
        turn.alexaSays = spec.reply ?? "";
      }
    } catch (error) {
      turn.error = error instanceof Error ? error.message : String(error);
      turn.alexaSays = "";
    }
    const last = turn.calls.at(-1);
    if (last?.structured) {
      scope.prev = last.structured;
      if (spec.id) scope[spec.id] = last.structured;
    }
    turn.chars = turn.alexaSays.length;
    turn.seconds = speakingSeconds(turn.alexaSays);
    turn.wallMs = Math.round((performance.now() - started) * 10) / 10;
    const observed = {
      speech: last && last.auth !== false ? last.speech : turn.alexaSays,
      tool: last?.tool,
      status: last?.status,
      wwwAuthenticate: last?.wwwAuthenticate,
      isError: last?.isError,
      nextPageToken: last?.nextPageToken,
      options: last?.options ?? 0,
      ms: last?.ms,
      toolsListed
    };
    const expect = { ...(spec.expect ?? {}) };
    if (brain && spec.tool) expect.tool = spec.tool;
    if (last?.auth === false) expect.isError ??= Boolean(last.isError);
    turn.checks = checkExpectations(expect, observed);
    if (turn.error) turn.checks.push({ check: "ran", ok: false, detail: turn.error });
    turn.pass = turn.checks.every((c) => c.ok);
    turns.push(turn);
    onTurn?.(publishTurn(turn), turns.length, script.turns.length);
  }
  return turns;
}

export { summarize };
