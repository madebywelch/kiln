#!/usr/bin/env node
// Stands in for `claude -p` and `codex exec` in worker tests. FAKE_MODE picks
// what it does; FAKE_RECORD names a file where it writes its argv and stdin.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const isCodex = args[0] === "exec";
const isOpencode = args[0] === "run";
const cwd = isCodex
  ? args[args.indexOf("-C") + 1]
  : isOpencode
    ? args[args.indexOf("--dir") + 1]
    : process.cwd();
// OpenCode takes the prompt as its last argument; the others read it from stdin.
const stdin = isOpencode ? args.at(-1) : readFileSync(0, "utf8");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
const mode = process.env.FAKE_MODE ?? "change";
const seen = {
  GH_TOKEN: process.env.GH_TOKEN ?? null,
  BOARD_TOKEN: process.env.BOARD_TOKEN ?? null,
  OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  KILN_SUBSCRIPTIONS: process.env.KILN_SUBSCRIPTIONS ?? null,
};
if (process.env.FAKE_RECORD) {
  writeFileSync(process.env.FAKE_RECORD, JSON.stringify({ args, stdin, cwd, head, env: seen }));
  // One line per run, for jobs that run the harness more than once.
  appendFileSync(
    `${process.env.FAKE_RECORD}.runs`,
    `${JSON.stringify({ args, token: seen.CLAUDE_CODE_OAUTH_TOKEN })}\n`,
  );
}

const line = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const SESSION = "ses-claude-1";
const RESETS_AT = 1_900_000_000;
if (!isCodex && !isOpencode) line({ type: "system", subtype: "init", session_id: SESSION });

/** Claude Code saying the subscription is out, then waiting, as it may instead of exiting. */
function exhaust() {
  line({
    type: "rate_limit_event",
    rate_limit_info: { status: "rejected", resetsAt: RESETS_AT, rateLimitType: "five_hour", utilization: 1 },
    session_id: SESSION,
  });
  setTimeout(() => process.exit(0), 60_000);
}

function finish(report) {
  if (isOpencode) {
    // Two messages: a working note, then the final one, split across text parts.
    const event = (messageID, text) =>
      `${JSON.stringify({ type: "text", sessionID: "ses_1", part: { type: "text", messageID, text } })}\n`;
    const [first, ...rest] = report.split(" ");
    process.stdout.write(event("msg_1", "Looking around."));
    process.stdout.write(event("msg_2", `${first} `));
    process.stdout.write(event("msg_2", rest.join(" ")));
    process.stdout.write(`${JSON.stringify({ type: "step_finish", part: { reason: "stop" } })}\n`);
  } else if (isCodex) {
    writeFileSync(args[args.indexOf("-o") + 1], `${report}\n`);
    process.stdout.write("codex: done\n");
  } else {
    line({
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        resetsAt: RESETS_AT,
        rateLimitType: "seven_day",
        utilization: 0.42,
      },
      session_id: SESSION,
    });
    line({ type: "result", is_error: false, result: report, session_id: SESSION });
  }
  process.exit(0);
}

switch (mode) {
  case "change":
    writeFileSync(join(cwd, "theme.css"), "body { background: snow; }\n");
    finish("Added snow to the landing page.\n\nVerified with the unit tests.");
    break;
  case "commit":
    writeFileSync(join(cwd, "theme.css"), "body { background: snow; }\n");
    execFileSync("git", ["add", "-A"], { cwd });
    execFileSync("git", ["commit", "-q", "-m", "Add snow"], { cwd });
    finish("Committed the snow.");
    break;
  case "artifact":
    writeFileSync(join(cwd, "theme.css"), "body { background: snow; }\n");
    mkdirSync(join(cwd, ".kiln", "artifacts"), { recursive: true });
    writeFileSync(join(cwd, ".kiln", "artifacts", "home.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    finish("Added snow. Screenshot attached.");
    break;
  case "nothing":
    finish("Nothing needed changing.");
    break;
  case "question":
    writeFileSync(join(cwd, "draft.css"), "/* half done */\n");
    finish("QUESTION: Which colors should the theme use?");
    break;
  case "claude-error":
    process.stdout.write(
      `${JSON.stringify({ type: "result", is_error: true, result: "usage limit reached" })}\n`,
    );
    process.exit(0);
    break;
  case "exhausted-first":
    // The first subscription runs out mid-job; the next one resumes the session and finishes.
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN === "sub-a") {
      writeFileSync(join(cwd, "theme.css"), "body { background: white; }\n");
      exhaust();
    } else {
      writeFileSync(join(cwd, "theme.css"), "body { background: snow; }\n");
      finish("Added snow to the landing page.");
    }
    break;
  case "exhausted-all":
    writeFileSync(join(cwd, "draft.css"), "/* half done */\n");
    exhaust();
    break;
  case "fail":
    process.stderr.write("working...\nboom: rate limited\n");
    process.exit(3);
    break;
  case "hang":
    setTimeout(() => finish("too late"), 60_000);
    break;
  default:
    process.stderr.write(`unknown FAKE_MODE ${mode}\n`);
    process.exit(64);
}
