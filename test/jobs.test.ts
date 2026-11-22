import { describe, expect, it } from "vitest";
import { HARNESSES } from "../lib/config.ts";
import type { RepoConfig } from "../lib/deployment.ts";
import {
  askerAuth,
  askerOf,
  askerOfSession,
  decodeJob,
  describeSelection,
  encodeJob,
  inferHarness,
  JobError,
  type JobSpec,
  jobBranch,
  jobRef,
  resolveSelection,
} from "../lib/jobs.ts";

const registry: Record<string, RepoConfig> = {
  web: { github: "acme/web", description: "the website" },
  api: {
    github: "acme/api",
    description: "the API",
    defaults: { change: { harness: "codex", model: "gpt-5.5", effort: "xhigh" } },
  },
  docs: {
    github: "acme/docs",
    description: "docs",
    defaults: { change: { effort: "low" }, investigate: { model: "haiku" } },
  },
};

const spec: JobSpec = {
  repo: "web",
  kind: "change",
  title: "Add a christmas theme",
  brief: "Snow on the landing page.\n\nKeep it subtle.",
  harness: "claude",
  model: "opus",
  effort: "high",
  origin: { channelId: "C0123", threadTs: "1731712345.000100" },
};

describe("resolveSelection", () => {
  it("rejects a repo outside the registry", () => {
    expect(() => resolveSelection("nope", "change", {}, registry, HARNESSES)).toThrow(
      /unknown repo or project "nope"/,
    );
  });

  it("rejects a model that belongs to another harness", () => {
    expect(() =>
      resolveSelection("web", "change", { harness: "codex", model: "opus" }, registry, HARNESSES),
    ).toThrow(/runs on claude, not codex/);
  });

  it("rejects a model whose harness it cannot tell", () => {
    expect(() => resolveSelection("web", "change", { model: "mystery-1" }, registry, HARNESSES)).toThrow(
      JobError,
    );
  });

  it("rejects a bare model name for opencode, which needs an AI Gateway ID", () => {
    expect(() =>
      resolveSelection("web", "change", { model: "deepseek-v4.1-flash" }, registry, HARNESSES),
    ).toThrow(/AI Gateway model ID/);
    expect(() =>
      resolveSelection("web", "change", { harness: "opencode", model: "luna" }, registry, HARNESSES),
    ).toThrow(/AI Gateway model ID/);
  });

  it("accepts an unknown model when the harness is named", () => {
    expect(
      resolveSelection("web", "change", { harness: "codex", model: "mystery-1" }, registry, HARNESSES),
    ).toEqual({
      harness: "codex",
      model: "mystery-1",
      effort: "high",
    });
  });

  it("runs workers on Claude Code only by default, refusing other harnesses' models with the reason", () => {
    expect(() =>
      resolveSelection("web", "investigate", { model: "deepseek/deepseek-v4.1-flash" }, registry),
    ).toThrow(/opencode \(deepseek\/deepseek-v4.1-flash\) is off: workers run claude only/);
    expect(() => resolveSelection("web", "change", { harness: "codex" }, registry)).toThrow(/codex is off/);
    expect(() => resolveSelection("api", "change", {}, registry)).toThrow(/codex .* is off/);
    expect(resolveSelection("web", "investigate", {}, registry)).toEqual({
      harness: "claude",
      model: "sonnet",
      effort: "high",
    });
  });

  it("researches with a fast model and implements with a heavy one by default", () => {
    expect(resolveSelection("web", "change", {}, registry, HARNESSES)).toEqual({
      harness: "claude",
      model: "opus",
      effort: "high",
    });
    expect(resolveSelection("web", "investigate", {}, registry, HARNESSES)).toEqual({
      harness: "claude",
      model: "sonnet",
      effort: "high",
    });
  });

  it("uses the repo's defaults for that kind of job over the global ones", () => {
    expect(resolveSelection("api", "change", {}, registry, HARNESSES)).toEqual({
      harness: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
    });
    expect(resolveSelection("api", "investigate", {}, registry, HARNESSES)).toEqual({
      harness: "claude",
      model: "sonnet",
      effort: "high",
    });
    expect(resolveSelection("docs", "change", {}, registry, HARNESSES)).toEqual({
      harness: "claude",
      model: "opus",
      effort: "low",
    });
    expect(resolveSelection("docs", "investigate", {}, registry, HARNESSES)).toEqual({
      harness: "claude",
      model: "haiku",
      effort: "high",
    });
  });

  it("puts what was asked for over every default, field by field", () => {
    expect(resolveSelection("api", "change", { effort: "low" }, registry, HARNESSES)).toEqual({
      harness: "codex",
      model: "gpt-5.5",
      effort: "low",
    });
    expect(resolveSelection("api", "change", { model: "sonnet" }, registry, HARNESSES)).toEqual({
      harness: "claude",
      model: "sonnet",
      effort: "xhigh",
    });
    expect(resolveSelection("web", "investigate", { model: "opus" }, registry, HARNESSES)).toEqual({
      harness: "claude",
      model: "opus",
      effort: "high",
    });
    expect(
      resolveSelection("web", "change", { model: "deepseek/deepseek-v4.1-flash" }, registry, HARNESSES),
    ).toEqual({
      harness: "opencode",
      model: "deepseek/deepseek-v4.1-flash",
      effort: "high",
    });
  });

  it("gives a named harness its own default model", () => {
    expect(resolveSelection("web", "change", { harness: "codex" }, registry, HARNESSES)).toEqual({
      harness: "codex",
      model: undefined,
      effort: "high",
    });
    expect(resolveSelection("web", "change", { harness: "opencode" }, registry, HARNESSES).model).toBe(
      "openai/gpt-6-luna-fast",
    );
    expect(resolveSelection("web", "investigate", { harness: "claude" }, registry, HARNESSES).model).toBe(
      "sonnet",
    );
    expect(resolveSelection("api", "change", { harness: "claude" }, registry, HARNESSES).model).toBe("opus");
    expect(resolveSelection("api", "change", { harness: "codex" }, registry, HARNESSES).model).toBe(
      "gpt-5.5",
    );
  });
});

describe("inferHarness", () => {
  it.each([
    ["opus", "claude"],
    ["claude-opus-5-5", "claude"],
    ["Sonnet", "claude"],
    ["gpt-5.5", "codex"],
    ["gpt-5.5-codex", "codex"],
    ["o4-mini", "codex"],
    ["openai/gpt-6-luna-fast", "opencode"],
    ["anthropic/claude-opus-5.5", "opencode"],
    ["deepseek-v4.1-flash", "opencode"],
    ["gpt-6-luna-fast", "opencode"],
    ["mystery", undefined],
  ])("%s runs on %s", (model, harness) => {
    expect(inferHarness(model)).toBe(harness);
  });
});

describe("encodeJob and decodeJob", () => {
  it("round-trips a job", () => {
    const encoded = encodeJob(spec);
    expect(encoded.labels).toMatchObject({
      kiln: "job",
      repo: "web",
      harness: "claude",
      slack: "C0123/1731712345.000100",
    });
    expect(decodeJob(encoded)).toEqual(spec);
  });

  it("round-trips a job without a model or an origin", () => {
    const bare = { ...spec, model: undefined, origin: undefined };
    const encoded = encodeJob(bare);
    expect(encoded.labels.model).toBeUndefined();
    expect(encoded.labels.slack).toBeUndefined();
    expect(decodeJob(encoded)).toEqual(bare);
  });

  it("refuses to encode what a board label cannot hold", () => {
    expect(() => encodeJob({ ...spec, title: "two\nlines" })).toThrow(/one line/);
    expect(() => encodeJob({ ...spec, title: "" })).toThrow(/title/);
    expect(() => encodeJob({ ...spec, brief: "x".repeat(9_001) })).toThrow(/brief/);
    expect(() => encodeJob({ ...spec, model: "m".repeat(300) })).toThrow(/too long/);
  });

  it("refuses a task that is not a kiln job", () => {
    expect(() => decodeJob({ text: "hi", labels: {} })).toThrow(/not a kiln job/);
  });

  it("refuses labels outside the contract", () => {
    const { text, labels } = encodeJob(spec);
    expect(() => decodeJob({ text, labels: { ...labels, harness: "cursor" } })).toThrow(/harness=cursor/);
    expect(() => decodeJob({ text, labels: { ...labels, effort: "extreme" } })).toThrow(/effort=extreme/);
    expect(() => decodeJob({ text, labels: { ...labels, slack: "C0123" } })).toThrow(/malformed/);
    const { repo: _repo, ...noRepo } = labels;
    expect(() => decodeJob({ text, labels: noRepo })).toThrow(/repo is missing/);
  });
});

describe("naming", () => {
  it("describes a selection", () => {
    expect(describeSelection({ harness: "codex", model: undefined, effort: "xhigh" })).toBe(
      "codex default/xhigh",
    );
  });

  it("makes a readable, safe branch name", () => {
    expect(jobBranch("812", "Add a Christmas theme!")).toBe("kiln/812-add-a-christmas-theme");
    expect(jobBranch("9", "???")).toBe("kiln/9");
    expect(jobBranch("9", "a".repeat(80))).toBe(`kiln/9-${"a".repeat(40)}`);
  });
});

describe("jobRef", () => {
  it("shortens a board ID to its first block, which survives being copied by a model", () => {
    expect(jobRef("msg_b799fe5c-a9d4-40f2-983a-6d9a6ad32dbd_1")).toBe("b799fe5c");
    expect(jobRef("812")).toBe("812");
  });
});

describe("the asker", () => {
  const slackUser = {
    authenticator: "slack-webhook",
    issuer: "slack:T0001",
    principalId: "slack:T0001:U0001",
    principalType: "user",
    attributes: { user_id: "U0001", channel_id: "C0123", email: "someone@example.com", action_token: "xyz" },
  };
  const asker = {
    authenticator: "slack-webhook",
    issuer: "slack:T0001",
    principalId: "slack:T0001:U0001",
    principalType: "user",
    userId: "U0001",
  };

  it("keeps a person's identity and Slack user ID, and nothing else from the turn's auth", () => {
    expect(askerOf(slackUser)).toEqual(asker);
  });

  it("is no one when the turn runs as the app or as nobody", () => {
    expect(
      askerOf({ authenticator: "app", principalId: "eve:app", principalType: "runtime" }),
    ).toBeUndefined();
    expect(askerOf({ authenticator: "none", principalId: "x", principalType: "anonymous" })).toBeUndefined();
    expect(askerOf(null)).toBeUndefined();
  });

  it("falls back to the person who started the session when the turn runs as the app", () => {
    const app = { authenticator: "app", principalId: "eve:app", principalType: "runtime" };
    expect(askerOfSession({ current: app, initiator: slackUser })).toEqual(asker);
    expect(askerOfSession({ current: slackUser, initiator: null })).toEqual(asker);
    expect(askerOfSession({ current: app, initiator: app })).toBeUndefined();
  });

  it("rides on the job and comes back, so its report can run as them", () => {
    const withAsker = { ...spec, origin: { ...(spec.origin as NonNullable<JobSpec["origin"]>), asker } };
    const encoded = encodeJob(withAsker);
    expect(JSON.parse(encoded.labels.asker ?? "")).toEqual(asker);
    expect(decodeJob(encoded)).toEqual(withAsker);
    expect(askerAuth(asker)).toEqual({
      authenticator: "slack-webhook",
      issuer: "slack:T0001",
      principalId: "slack:T0001:U0001",
      principalType: "user",
      attributes: { user_id: "U0001" },
    });
  });

  it("drops a malformed asker without losing the job or its thread", () => {
    const { text, labels } = encodeJob(spec);
    for (const bad of ["{", '{"principalType":"user"}', "[]"]) {
      expect(decodeJob({ text, labels: { ...labels, asker: bad } }).origin).toEqual(spec.origin);
    }
  });
});
