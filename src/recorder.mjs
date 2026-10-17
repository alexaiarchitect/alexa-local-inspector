// Records the flow: an append-only events.jsonl plus the snapshot files
// Amazon's inspector writes (tools.json, tool-result.json, state.json,
// inspection-summary.json, certification-verdict.json), a Markdown transcript,
// and a timestamped copy of everything under sessions/<started>/ so no run is
// ever overwritten.
import { appendFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_OUT_DIR = "/tmp/alexa-local-inspector-live";

export class Recorder {
  constructor(outDir = DEFAULT_OUT_DIR) {
    this.outDir = outDir;
    this.startedAt = new Date().toISOString();
    this.sessionDir = join(outDir, "sessions", this.startedAt.replace(/[:.]/gu, "-"));
    this.files = new Set();
    mkdirSync(join(outDir, "screenshots"), { recursive: true });
    for (const stale of ["events.jsonl", "tools.json", "tool-result.json", "state.json"]) {
      const path = join(outDir, stale);
      if (existsSync(path)) rmSync(path);
    }
    rmSync(join(outDir, "screenshots"), { recursive: true, force: true });
    mkdirSync(join(outDir, "screenshots"), { recursive: true });
  }

  path(name) {
    return join(this.outDir, name);
  }

  event(event) {
    appendFileSync(this.path("events.jsonl"), `${JSON.stringify(event)}\n`);
    this.files.add("events.jsonl");
  }

  json(name, value) {
    writeFileSync(this.path(name), `${JSON.stringify(value, null, 2)}\n`);
    this.files.add(name);
  }

  text(name, value) {
    writeFileSync(this.path(name), value);
    this.files.add(name);
  }

  /** Copy the live directory into sessions/<started>/ (idempotent). */
  archive() {
    mkdirSync(this.sessionDir, { recursive: true });
    for (const name of this.files) cpSync(this.path(name), join(this.sessionDir, name));
    cpSync(this.path("screenshots"), join(this.sessionDir, "screenshots"), { recursive: true });
    return this.sessionDir;
  }
}
