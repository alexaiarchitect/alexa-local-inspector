// An Alexa+-like "brain": Claude picks the tool and arguments for each
// utterance from the server's tools/list, calls it through the inspector's
// client (so every call is recorded), and says the answer. Uses the
// Anthropic Messages API directly (fetch, no SDK). Needs ANTHROPIC_API_KEY.
import { speakable } from "./voice.mjs";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

export function claudeAvailability(env = process.env) {
  return env.ANTHROPIC_API_KEY
    ? { ok: true }
    : { ok: false, reason: "missing ANTHROPIC_API_KEY in the environment" };
}

/** Anthropic tool definitions for a tools/list result. */
export function claudeTools(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? tool.title ?? tool.name,
    input_schema: tool.inputSchema ?? { type: "object" }
  }));
}

export function systemPrompt(locale) {
  return [
    `You are Alexa+, a voice assistant, speaking ${locale}. The user talks to an add-on through you.`,
    "Use the tools to answer. Never invent data. Keep every answer to one or two short spoken sentences, no markdown, no identifiers.",
    "Logging is two steps: a tool that previews an entry reads it back; only after the user clearly says yes call the confirming tool with the id from that preview. If the user says no, do not call any tool.",
    "When the user says 'more' / 'más', call the same tool again with the next_page_token from the previous result as page_token."
  ].join(" ");
}

export class ClaudeBrain {
  constructor({ model = DEFAULT_MODEL, locale, tools, env = process.env, fetchImpl = fetch }) {
    this.model = model;
    this.locale = locale;
    this.tools = claudeTools(tools);
    this.env = env;
    this.fetch = fetchImpl;
    this.messages = [];
    this.system = systemPrompt(locale);
  }

  get label() {
    return `claude \`${this.model}\` (model picks tools and args)`;
  }

  async complete() {
    const body = JSON.stringify({
      model: this.model,
      max_tokens: 400,
      temperature: 0,
      system: this.system,
      tools: this.tools,
      messages: this.messages
    });
    const response = await this.fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.env.ANTHROPIC_API_KEY,
        "anthropic-version": API_VERSION
      },
      body,
      signal: AbortSignal.timeout(60_000)
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        `Anthropic ${response.status}: ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`
      );
    return json;
  }

  /** One user turn: let the model call tools (at most 3 rounds) and return what Alexa says. */
  async turn(utterance, client) {
    this.messages.push({ role: "user", content: [{ type: "text", text: utterance }] });
    const calls = [];
    let modelMs = 0;
    for (let round = 0; round < 4; round += 1) {
      const started = performance.now();
      const reply = await this.complete();
      modelMs += performance.now() - started;
      const content = reply.content ?? [];
      this.messages.push({ role: "assistant", content });
      const uses = content.filter((block) => block.type === "tool_use");
      if (!uses.length || round === 3) {
        const text = content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join(" ");
        return { calls, alexaSays: text.trim(), modelMs: Math.round(modelMs) };
      }
      const results = [];
      for (const use of uses) {
        const call = await client.callTool(use.name, use.input);
        calls.push({ tool: use.name, args: use.input, response: call });
        const result = call.message?.result;
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(result?.structuredContent ?? { speech: speakable(result) }),
          ...(result?.isError || call.message?.error ? { is_error: true } : {})
        });
      }
      this.messages.push({ role: "user", content: results });
    }
    return { calls, alexaSays: "", modelMs: Math.round(modelMs) };
  }
}
