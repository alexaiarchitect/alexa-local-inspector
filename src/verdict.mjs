// Production-readiness verdict: each rule is PASS / FAIL / WARN with evidence,
// summed up as CERTIFIED (no FAIL, no WARN), CONDITIONAL (WARN only) or
// NOT_CERTIFIED (any FAIL). Data-layer rules follow the Alexa+ MCP toolkit
// requirements (voice-shaped tools, 500 ms budget, bare 401, PRM + RFC 8414
// metadata); visual rules apply only when a tool declares a ui:// resource.
import { DEFAULTS, percentile, speakingSeconds, UUID, TOKENISH } from "./voice.mjs";

const SCREEN_WORDS = /\b(click|tap|swipe|scroll|screen|button|json|widget|iframe)\b/iu;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/u;

function rule(id, title, status, evidence) {
  return { id, title, status, evidence };
}

/** Compute the verdict from an inspector state snapshot. */
export function evaluate(state) {
  const rules = [];
  const tools = state.tools ?? [];
  const session = state.session;
  const calls = state.calls ?? [];
  const toolCalls = calls.filter((c) => c.method === "tools/call" && c.auth);
  const turns = state.conversation?.turns ?? [];

  // --- handshake and discovery
  rules.push(
    session?.protocolVersion
      ? rule(
          "ALX-HANDSHAKE",
          "Legacy 2025-11-25 handshake accepted",
          session.protocolVersion === session.requestedProtocolVersion ? "PASS" : "WARN",
          `requested ${session.requestedProtocolVersion}, negotiated ${session.protocolVersion}`
        )
      : rule("ALX-HANDSHAKE", "Legacy 2025-11-25 handshake accepted", "FAIL", "no initialize result")
  );
  rules.push(
    rule(
      "ALX-TOOLS-PRESENT",
      "tools/list returns at least one tool",
      tools.length ? "PASS" : "FAIL",
      `${tools.length} tools`
    )
  );
  if (state.toolsStable !== undefined)
    rules.push(
      rule(
        "ALX-TOOLS-STABLE",
        "tools/list is identical across calls (Alexa+ caches it until redeploy)",
        state.toolsStable ? "PASS" : "FAIL",
        state.toolsStable ? "two listings equal" : "listings differ"
      )
    );

  // --- tool shape
  const badNames = tools.filter((t) => !TOOL_NAME.test(t.name)).map((t) => t.name);
  rules.push(
    rule(
      "ALX-TOOL-NAMES",
      "Tool names are snake_case, ≤ 64 chars",
      badNames.length ? "FAIL" : "PASS",
      badNames.length ? badNames.join(", ") : `${tools.length} names ok`
    )
  );
  const noSchema = tools.filter((t) => t.inputSchema?.type !== "object").map((t) => t.name);
  rules.push(
    rule(
      "ALX-INPUT-SCHEMA",
      "Every tool has an object inputSchema",
      noSchema.length ? "FAIL" : "PASS",
      noSchema.length ? noSchema.join(", ") : "all object"
    )
  );
  const shortDesc = tools.filter((t) => (t.description ?? "").length < 20).map((t) => t.name);
  rules.push(
    rule(
      "ALX-DESCRIPTIONS",
      "Descriptions are long enough for the model to pick the tool (≥ 20 chars)",
      shortDesc.length ? "WARN" : "PASS",
      shortDesc.length ? shortDesc.join(", ") : "ok"
    )
  );
  const screenRefs = tools
    .filter((t) => SCREEN_WORDS.test(`${t.description ?? ""} ${t.title ?? ""}`))
    .map((t) => t.name);
  rules.push(
    rule(
      "ALX-NO-SCREEN-WORDS",
      "Descriptions do not refer to a screen (click, tap, JSON…)",
      screenRefs.length ? "WARN" : "PASS",
      screenRefs.length ? screenRefs.join(", ") : "none"
    )
  );
  const tooMany = tools.length > 20;
  rules.push(
    rule(
      "ALX-TOOL-COUNT",
      "A voice surface stays small (≤ 20 tools)",
      tooMany ? "WARN" : "PASS",
      `${tools.length}`
    )
  );

  // --- conversation (only when the driver ran)
  if (turns.length) {
    const failed = turns.filter((t) => !t.pass);
    rules.push(
      rule(
        "ALX-SCRIPT",
        "Every scripted turn passed its voice checks",
        failed.length ? "FAIL" : "PASS",
        failed.length
          ? failed.map((t) => `#${t.n} ${t.checks.filter((c) => !c.ok).map((c) => c.check).join("/")}`).join("; ")
          : `${turns.length}/${turns.length}`
      )
    );
    const options = Math.max(0, ...turns.flatMap((t) => t.calls.map((c) => c.options ?? 0)));
    rules.push(
      rule(
        "ALX-MAX-OPTIONS",
        `No answer offers more than ${DEFAULTS.maxOptions} options`,
        options <= DEFAULTS.maxOptions ? "PASS" : "FAIL",
        `max ${options}`
      )
    );
    const longest = Math.max(0, ...turns.map((t) => speakingSeconds(t.alexaSays ?? "")));
    rules.push(
      rule(
        "ALX-SPEECH-LENGTH",
        `Every answer is under ${DEFAULTS.maxSeconds} s of speech`,
        longest <= DEFAULTS.maxSeconds ? "PASS" : "FAIL",
        `longest ≈ ${longest} s`
      )
    );
    const ids = turns.filter((t) => UUID.test(t.alexaSays ?? "") || TOKENISH.test(t.alexaSays ?? ""));
    rules.push(
      rule(
        "ALX-NO-IDS",
        "No identifiers or tokens are spoken",
        ids.length ? "FAIL" : "PASS",
        ids.length ? ids.map((t) => `#${t.n}`).join(", ") : "none"
      )
    );
    const unlinked = turns.flatMap((t) => t.calls.filter((c) => c.auth === false));
    if (unlinked.length) {
      const bad = unlinked.filter((c) => c.status !== 401 || c.wwwAuthenticate);
      rules.push(
        rule(
          "ALX-BARE-401",
          "Without a token the server answers 401 without WWW-Authenticate (starts account linking)",
          bad.length ? "FAIL" : "PASS",
          bad.length
            ? bad.map((c) => `HTTP ${c.status}${c.wwwAuthenticate ? " + WWW-Authenticate" : ""}`).join("; ")
            : `${unlinked.length} bare 401`
        )
      );
    }
  }

  // --- latency
  const ms = toolCalls.map((c) => c.ms).filter((v) => typeof v === "number");
  if (ms.length) {
    const p95 = percentile(ms, 95);
    const max = Math.max(...ms);
    rules.push(
      rule(
        "ALX-LATENCY",
        `tools/call p95 within the ${DEFAULTS.maxMs} ms round-trip budget`,
        p95 <= DEFAULTS.maxMs ? (max <= DEFAULTS.maxMs ? "PASS" : "WARN") : "FAIL",
        `p50 ${percentile(ms, 50)} ms, p95 ${p95} ms, max ${max} ms over ${ms.length} calls`
      )
    );
  }
  const errors = toolCalls.filter((c) => c.status >= 500 || c.failure);
  rules.push(
    rule(
      "ALX-NO-5XX",
      "No tool call failed with a transport error or 5xx",
      errors.length ? "FAIL" : "PASS",
      errors.length ? `${errors.length} failures` : `${toolCalls.length} calls`
    )
  );

  // --- authorization metadata
  const prm = state.metadata?.prm;
  const as = state.metadata?.as;
  if (prm === undefined && as === undefined) {
    rules.push(rule("ALX-PRM", "Protected Resource Metadata served", "WARN", "not fetched"));
  } else {
    rules.push(
      prm
        ? rule(
            "ALX-PRM",
            "Protected Resource Metadata names this server as its resource",
            prm.resource === state.serverUrl ? "PASS" : "FAIL",
            `resource ${prm.resource}; scopes ${(prm.scopes_supported ?? []).length}`
          )
        : rule("ALX-PRM", "Protected Resource Metadata served", "FAIL", "none found")
    );
    rules.push(
      as
        ? rule(
            "ALX-AS-METADATA",
            "RFC 8414 metadata lists S256 and client_credentials",
            (as.code_challenge_methods_supported ?? []).includes("S256") &&
              (as.grant_types_supported ?? []).includes("client_credentials") &&
              (as.grant_types_supported ?? []).includes("authorization_code")
              ? "PASS"
              : "FAIL",
            `grants ${(as.grant_types_supported ?? []).join(",")}; pkce ${(as.code_challenge_methods_supported ?? []).join(",")}`
          )
        : rule("ALX-AS-METADATA", "RFC 8414 authorization-server metadata served", "FAIL", "none found")
    );
  }
  if (state.link?.status === "linked")
    rules.push(
      rule(
        "ALX-LINKING",
        "Account linking completed (authorization code + PKCE)",
        "PASS",
        `scopes granted: ${(state.link.scopesGranted ?? []).join(" ") || "(not echoed)"}`
      )
    );

  // --- visual (only for tools that declare a ui:// resource)
  const widgets = tools.filter((t) => widgetUri(t));
  if (widgets.length) {
    const shots = state.screenshots ?? [];
    for (const tool of widgets) {
      const mine = shots.filter((s) => s.tool === tool.name);
      rules.push(
        rule(
          `VIS-${tool.name}`,
          `Widget of ${tool.name} rendered on every device surface`,
          mine.length >= 2 ? (mine.every((s) => s.issues.length === 0) ? "PASS" : "WARN") : "WARN",
          mine.length
            ? mine.map((s) => `${s.surface}: ${s.issues.length ? s.issues.join(", ") : "ok"}`).join("; ")
            : "no screenshots (run visual mode)"
        )
      );
    }
  }

  const verdict = rules.some((r) => r.status === "FAIL")
    ? "NOT_CERTIFIED"
    : rules.some((r) => r.status === "WARN")
      ? "CONDITIONAL"
      : "CERTIFIED";
  return {
    verdict,
    evaluatedAt: new Date().toISOString(),
    server: state.serverUrl,
    counts: {
      pass: rules.filter((r) => r.status === "PASS").length,
      warn: rules.filter((r) => r.status === "WARN").length,
      fail: rules.filter((r) => r.status === "FAIL").length
    },
    rules
  };
}

export function widgetUri(tool) {
  return tool?._meta?.ui?.resourceUri ?? tool?._meta?.["ui/resourceUri"];
}
