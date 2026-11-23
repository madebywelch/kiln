#!/usr/bin/env node
// Stands in for `claude -p` and `codex exec` in worker tests. FAKE_MODE picks
// what it does; FAKE_RECORD names a file where it writes its argv and stdin.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
// A project job runs above its repos, where there is no HEAD.
let head = null;
try {
  head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {}
const mode = process.env.FAKE_MODE ?? "change";
const seen = {
  GH_TOKEN: process.env.GH_TOKEN ?? null,
  BOARD_TOKEN: process.env.BOARD_TOKEN ?? null,
  OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
  INFERENCE_API_KEY: process.env.INFERENCE_API_KEY ?? null,
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
if (!isCodex && !isOpencode) line({ type: "system", subtype: "init", session_id: SESSION });

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
    line({ type: "result", is_error: false, result: report, session_id: SESSION });
  }
  process.exit(0);
}

switch (mode) {
  case "change":
    writeFileSync(join(cwd, "theme.css"), "body { background: snow; }\n");
    finish("Added snow to the landing page.\n\nVerified with the unit tests.");
    break;
  case "pr-file":
    writeFileSync(join(cwd, "theme.css"), "body { background: snow; }\n");
    mkdirSync(join(cwd, ".kiln"), { recursive: true });
    writeFileSync(
      join(cwd, ".kiln", "pr.md"),
      "## Snow on the landing page\n\nAdds a snow layer. Verified with the unit tests.\n",
    );
    finish("Added snow. Screenshots are in .kiln/artifacts/.");
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
  case "place-input": {
    // Does what a brief asks of an attached file: put it in the repo, at public/.
    const name = readdirSync(join(cwd, ".kiln", "inputs"))[0];
    mkdirSync(join(cwd, "public"), { recursive: true });
    copyFileSync(join(cwd, ".kiln", "inputs", name), join(cwd, "public", name));
    finish(`Put ${name} in public/.`);
    break;
  }
  case "project":
  case "project-one": {
    // A project job runs above its repos: change each one, or only the last.
    const repos = readdirSync(cwd)
      .filter((name) => existsSync(join(cwd, name, ".git")))
      .sort();
    for (const name of mode === "project" ? repos : repos.slice(-1)) {
      writeFileSync(join(cwd, name, "theme.css"), "body { background: snow; }\n");
    }
    mkdirSync(join(cwd, ".kiln"), { recursive: true });
    writeFileSync(join(cwd, ".kiln", "pr.md"), "Snow across the shop.\n");
    writeFileSync(join(cwd, ".kiln", `pr-${repos[0]}.md`), `Snow in ${repos[0]}.\n`);
    finish(`Changed ${mode === "project" ? repos.join(" and ") : repos.at(-1)}.`);
    break;
  }
  case "nothing":
    finish("Nothing needed changing.");
    break;
  case "long-report":
    // An investigation whose final message is the whole deliverable, longer than a job update carries.
    finish(`Findings.\n\n${"A finding worth reading. ".repeat(600)}\n\nThe proposal is at the end.`);
    break;
  case "question":
    writeFileSync(join(cwd, "draft.css"), "/* half done */\n");
    finish("QUESTION: Which colors should the theme use?");
    break;
  case "secret":
    writeFileSync(join(cwd, "draft.css"), "/* half done */\n");
    finish("SECRET: STRIPE_API_KEY, DATABASE_URL: read the customer's payment history");
    break;
  case "claude-error":
    process.stdout.write(
      `${JSON.stringify({ type: "result", is_error: true, result: "usage limit reached" })}\n`,
    );
    process.exit(0);
    break;
  case "noisy-fail": {
    // What OpenCode printed when a model rejected an MCP tool's schema: noise on stderr, the cause on stdout.
    for (let i = 0; i < 500; i++)
      process.stderr.write(`unknown format "uint32" ignored in schema at path "#/x/${i}"\n`);
    const rejected = {
      type: "error",
      error: {
        message:
          "Invalid JSON schema: regex lookaround is not supported. Found at $.properties.email.pattern.",
      },
    };
    const message = JSON.stringify({ name: "AI_TypeValidationError", value: rejected });
    line({ type: "error", error: { name: "UnknownError", data: { message } } });
    process.exit(1);
    break;
  }
  case "rate-limited":
    // What Claude Code printed when the endpoint's account ran out: an error result, then exit 1.
    writeFileSync(join(cwd, "draft.css"), "/* half done */\n");
    line({
      type: "result",
      is_error: true,
      api_error_status: 429,
      result:
        "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down via provider claude (last error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.) (reset after 1h32m14s)",
      session_id: SESSION,
    });
    process.exit(1);
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
