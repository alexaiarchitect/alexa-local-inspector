// Markdown transcript of a run, same structure as the alexa-sim transcripts in
// aobrain-vault-alexa/docs/demo/, extended with the recorded link flow and the
// verdict table.
import { CLIENT_INFO } from "./mcp-client.mjs";
import { DEFAULTS } from "./voice.mjs";

const cell = (value) =>
  String(value ?? "")
    .replace(/\|/gu, "\\|")
    .replace(/\r?\n/gu, " ");

export function renderTranscript(state) {
  const lines = [];
  const c = state.conversation;
  const s = c?.summary;
  const h = state.session;
  lines.push(`# Alexa+ local inspection — ${state.serverUrl}`);
  lines.push("");
  if (s)
    lines.push(
      `**Conversation: ${s.verdict}** — ${s.passed}/${s.turns} turns passed; tool calls p50 ${s.p50Ms} ms, p95 ${s.p95Ms} ms, max ${s.maxMs} ms; handshake ${h?.handshake?.totalMs ?? "–"} ms.`
    );
  if (state.verdict)
    lines.push(
      `**Certification: ${state.verdict.verdict}** — ${state.verdict.counts.pass} pass, ${state.verdict.counts.warn} warn, ${state.verdict.counts.fail} fail.`
    );
  lines.push("");
  lines.push("| Run | |");
  lines.push("| --- | --- |");
  lines.push(`| Started (UTC) | ${state.startedAt} |`);
  lines.push(`| Server | \`${state.serverUrl}\` |`);
  lines.push(`| Client | ${CLIENT_INFO.name} ${CLIENT_INFO.version} (Node ${process.versions.node}) |`);
  lines.push(
    `| Locale | \`Accept-Language: ${state.locale}\`${state.metaLocale ? ", `_meta.locale`" : ""} |`
  );
  lines.push(`| Token | ${state.tokenSource ?? "none"} |`);
  if (c) {
    lines.push(`| Brain | ${cell(c.brain)} |`);
    lines.push(`| Script | \`${cell(c.script)}\` |`);
  }
  lines.push(`| Output | \`${state.outDir}\` |`);
  lines.push("");
  if (h?.protocolVersion) {
    lines.push("## Handshake");
    lines.push("");
    lines.push(
      `- Requested protocol \`${h.requestedProtocolVersion}\`, negotiated \`${h.protocolVersion}\``
    );
    lines.push(
      `- Server: **${cell(h.serverInfo?.title ?? h.serverInfo?.name)}** (\`${cell(h.serverInfo?.name)}\` ${cell(h.serverInfo?.version)})`
    );
    lines.push(`- Capabilities: ${(h.capabilities ?? []).map((x) => `\`${x}\``).join(", ") || "none"}`);
    lines.push(
      `- Session: ${h.sessionId ? "`Mcp-Session-Id` issued" : "stateless (no `Mcp-Session-Id`)"}`
    );
    lines.push(
      `- Tools (${(state.tools ?? []).length}): ${(state.tools ?? []).map((t) => `\`${t.name}\``).join(", ")}`
    );
    lines.push("");
    if (h.handshake?.steps) {
      lines.push("| Step | HTTP | ms |");
      lines.push("| --- | --- | --- |");
      for (const step of h.handshake.steps) lines.push(`| ${step.step} | ${step.status} | ${step.ms} |`);
      lines.push(`| **total** | | **${h.handshake.totalMs}** |`);
      lines.push("");
    }
  }
  if (state.link?.status) {
    lines.push("## Account linking");
    lines.push("");
    const l = state.link;
    lines.push(`- Status: **${l.status}**${l.error ? ` — ${cell(l.error)}` : ""}`);
    if (l.authorizationEndpoint) lines.push(`- Authorization endpoint: \`${l.authorizationEndpoint}\``);
    if (l.tokenEndpoint) lines.push(`- Token endpoint: \`${l.tokenEndpoint}\``);
    if (l.scopesRequested) lines.push(`- Scopes requested: ${l.scopesRequested.map((x) => `\`${x}\``).join(", ")}`);
    if (l.scopesGranted) lines.push(`- Scopes granted: ${l.scopesGranted.map((x) => `\`${x}\``).join(", ")}`);
    if (l.claims)
      lines.push(
        `- Token: \`${cell(l.claims.token_use)}\` for client \`${cell(l.claims.client_id)}\`, aud \`${cell(l.claims.aud)}\`, exchange ${l.tokenExchangeMs} ms`
      );
    lines.push("");
  }
  if (c?.turns?.length) {
    lines.push("## Conversation");
    lines.push("");
    for (const turn of c.turns) {
      lines.push(`### ${turn.n}. ${turn.pass ? "PASS" : "FAIL"} — “${cell(turn.say)}”`);
      lines.push("");
      lines.push("| | |");
      lines.push("| --- | --- |");
      lines.push(`| Utterance | ${cell(turn.say)} |`);
      for (const call of turn.calls) {
        lines.push(
          `| Tool | \`${call.tool}\`${call.auth === false ? " (no token)" : ""} → HTTP ${call.status}${call.isError ? ", isError" : ""} |`
        );
        lines.push(`| Args | \`${cell(JSON.stringify(call.args))}\` |`);
        lines.push(`| Server speech | ${cell(call.speech)} |`);
        lines.push(`| ms | ${call.ms} |`);
      }
      if (!turn.calls.length) lines.push("| Tool | none (handled by Alexa) |");
      lines.push(`| Alexa says | ${cell(turn.alexaSays)} |`);
      lines.push(`| Chars / est. speech | ${turn.chars} / ${turn.seconds} s |`);
      if (turn.note) lines.push(`| Note | ${cell(turn.note)} |`);
      lines.push(
        `| Checks | ${turn.checks.map((x) => `${x.ok ? "✓" : "✗"} ${cell(x.check)}${x.detail && !x.ok ? ` (${cell(x.detail)})` : ""}`).join("; ")} |`
      );
      lines.push(`| Result | **${turn.pass ? "PASS" : "FAIL"}** |`);
      lines.push("");
    }
    lines.push("## Conversation verdict");
    lines.push("");
    lines.push(`- Turns: **${s.passed}/${s.turns} passed**`);
    lines.push(
      `- Tool-call latency (end to end, ${s.calls} calls): p50 **${s.p50Ms} ms**, p95 **${s.p95Ms} ms**, max ${s.maxMs} ms (budget ${DEFAULTS.maxMs} ms)`
    );
    lines.push(`- Handshake: ${h?.handshake?.totalMs ?? "–"} ms`);
    lines.push(
      `- Longest answer: ${s.longestChars} chars, ≈${s.longestSeconds} s spoken (limit ${DEFAULTS.maxSeconds} s)`
    );
    for (const w of c.warnings ?? []) lines.push(`- Warning: ${w}`);
    lines.push(`- **${s.verdict}**`);
    lines.push("");
  }
  if (state.verdict) {
    lines.push("## Certification verdict");
    lines.push("");
    lines.push(`**${state.verdict.verdict}**`);
    lines.push("");
    lines.push("| Rule | Status | Evidence |");
    lines.push("| --- | --- | --- |");
    for (const r of state.verdict.rules)
      lines.push(`| ${cell(r.title)} (\`${r.id}\`) | ${r.status} | ${cell(r.evidence)} |`);
    lines.push("");
  }
  if (state.screenshots?.length) {
    lines.push("## Screenshots");
    lines.push("");
    for (const shot of state.screenshots)
      lines.push(`- \`${shot.tool}\` on ${shot.surface}: \`${shot.file}\`${shot.issues.length ? ` — ${shot.issues.join(", ")}` : ""}`);
    lines.push("");
  }
  lines.push("## Requests");
  lines.push("");
  lines.push("| # | Method | Tool | HTTP | ms | Error |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const call of state.calls ?? [])
    lines.push(
      `| ${call.seq} | ${call.method ?? ""} | ${call.name ?? ""} | ${call.status}${call.auth ? "" : " (no token)"} | ${call.ms} | ${call.isError ? "yes" : ""} |`
    );
  lines.push("");
  return lines.join("\n");
}
