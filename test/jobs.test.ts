import { describe, expect, it } from "vitest";
import type { RepoConfig } from "../lib/config.ts";
import {
  decodeJob,
  describeSelection,
  encodeJob,
  inferHarness,
  JobError,
  type JobSpec,
  jobBranch,
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
    defaults: { change: { effort: "low" }, investigate: { model: "deepseek/deepseek-v4.1-flash" } },
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
    expect(() => resolveSelection("nope", "change", {}, registry)).toThrow(/unknown repo "nope"/);
  });

  it("rejects a model that belongs to another harness", () => {
    expect(() => resolveSelection("web", "change", { harness: "codex", model: "opus" }, registry)).toThrow(
      /runs on claude, not codex/,
    );
  });

  it("rejects a model whose harness it cannot tell", () => {
    expect(() => resolveSelection("web", "change", { model: "mystery-1" }, registry)).toThrow(JobError);
  });

  it("rejects a bare model name for opencode, which needs an AI Gateway ID", () => {
    expect(() => resolveSelection("web", "change", { model: "deepseek-v4.1-flash" }, registry)).toThrow(
      /AI Gateway model ID/,
    );
    expect(() => resolveSelection("web", "change", { harness: "opencode", model: "luna" }, registry)).toThrow(
      /AI Gateway model ID/,
    );
  });

  it("accepts an unknown model when the harness is named", () => {
    expect(resolveSelection("web", "change", { harness: "codex", model: "mystery-1" }, registry)).toEqual({
      harness: "codex",
      model: "mystery-1",
      effort: "high",
    });
  });

  it("reads with a cheap model and writes with a heavy one by default", () => {
    expect(resolveSelection("web", "change", {}, registry)).toEqual({
      harness: "claude",
      model: "opus",
      effort: "high",
    });
    expect(resolveSelection("web", "investigate", {}, registry)).toEqual({
      harness: "opencode",
      model: "openai/gpt-6-luna-fast",
      effort: "medium",
    });
  });

  it("uses the repo's defaults for that kind of job over the global ones", () => {
    expect(resolveSelection("api", "change", {}, registry)).toEqual({
      harness: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
    });
    expect(resolveSelection("api", "investigate", {}, registry)).toEqual({
      harness: "opencode",
      model: "openai/gpt-6-luna-fast",
      effort: "medium",
    });
    expect(resolveSelection("docs", "change", {}, registry)).toEqual({
      harness: "claude",
      model: "opus",
      effort: "low",
    });
    expect(resolveSelection("docs", "investigate", {}, registry)).toEqual({
      harness: "opencode",
      model: "deepseek/deepseek-v4.1-flash",
      effort: "medium",
    });
  });

  it("puts what was asked for over every default, field by field", () => {
    expect(resolveSelection("api", "change", { effort: "low" }, registry)).toEqual({
      harness: "codex",
      model: "gpt-5.5",
      effort: "low",
    });
    expect(resolveSelection("api", "change", { model: "sonnet" }, registry)).toEqual({
      harness: "claude",
      model: "sonnet",
      effort: "xhigh",
    });
    expect(resolveSelection("web", "investigate", { model: "opus" }, registry)).toEqual({
      harness: "claude",
      model: "opus",
      effort: "medium",
    });
    expect(resolveSelection("web", "change", { model: "deepseek/deepseek-v4.1-flash" }, registry)).toEqual({
      harness: "opencode",
      model: "deepseek/deepseek-v4.1-flash",
      effort: "high",
    });
  });

  it("gives a named harness its own default model", () => {
    expect(resolveSelection("web", "change", { harness: "codex" }, registry)).toEqual({
      harness: "codex",
      model: undefined,
      effort: "high",
    });
    expect(resolveSelection("web", "change", { harness: "opencode" }, registry).model).toBe(
      "openai/gpt-6-luna-fast",
    );
    expect(resolveSelection("web", "investigate", { harness: "claude" }, registry).model).toBe("opus");
    expect(resolveSelection("api", "change", { harness: "claude" }, registry).model).toBe("opus");
    expect(resolveSelection("api", "change", { harness: "codex" }, registry).model).toBe("gpt-5.5");
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
      robdog: "job",
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

  it("refuses a task that is not a robdog job", () => {
    expect(() => decodeJob({ text: "hi", labels: {} })).toThrow(/not a robdog job/);
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
    expect(jobBranch("812", "Add a Christmas theme!")).toBe("robdog/812-add-a-christmas-theme");
    expect(jobBranch("9", "???")).toBe("robdog/9");
    expect(jobBranch("9", "a".repeat(80))).toBe(`robdog/9-${"a".repeat(40)}`);
  });
});
