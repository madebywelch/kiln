import { type Board, board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { beforeEach, describe, expect, it } from "vitest";
import {
  answerJob,
  cancelJob,
  listJobs,
  postJob,
  readJob,
  reportMessage,
  sweepReports,
} from "../lib/board-jobs.ts";
import { JOBS_CHANNEL, type JobSpec, REPORT_LABEL, REPORT_PENDING } from "../lib/jobs.ts";

const spec: JobSpec = {
  repo: "player.games-app",
  kind: "change",
  title: "Add a christmas theme",
  brief: "Snow on the landing page.",
  harness: "claude",
  model: "opus",
  effort: "high",
  origin: { channelId: "C0123", threadTs: "1731712345.000100" },
};

let team: Board;
let worker: Board;

beforeEach(() => {
  team = board({ backend: local({ memory: true }) });
  worker = team.as("claude-1");
});

async function claimAs(handle: Board) {
  const claim = await handle.tasks.claim({
    channel: JOBS_CHANNEL,
    label: { robdog: "job" },
    from: ["board:client"],
  });
  if (!claim) throw new Error("nothing to claim");
  return claim;
}

describe("posting and reading jobs", () => {
  it("posts a job a worker can claim by harness", async () => {
    const job = await postJob(team, spec);
    expect(job).toMatchObject({
      state: "ready",
      repo: spec.repo,
      runsOn: "claude opus/high",
      origin: spec.origin,
    });
    const claim = await worker.tasks.claim({
      channel: JOBS_CHANNEL,
      label: { robdog: "job", harness: "claude" },
      from: ["board:client"],
    });
    expect(claim?.task.id).toBe(job.id);
    const codex = await team.as("codex-1").tasks.claim({
      channel: JOBS_CHANNEL,
      label: { robdog: "job", harness: "codex" },
      from: ["board:client"],
    });
    expect(codex).toBeNull();
  });

  it("lists jobs and skips foreign tasks in the channel", async () => {
    await postJob(team, spec);
    await team.tasks.create(JOBS_CHANNEL, { text: "someone else's task", labels: { robdog: "job" } });
    const jobs = await listJobs(team);
    expect(jobs.map((job) => job.title)).toEqual([spec.title]);
  });

  it("reads a job's log", async () => {
    const job = await postJob(team, spec);
    await worker.reply(job.id, "cloned, running claude");
    const { log } = await readJob(team, job.id);
    expect(log).toEqual([expect.objectContaining({ by: "claude-1", text: "cloned, running claude" })]);
  });
});

describe("cancelJob", () => {
  it("cancels and clears a pending report so nothing is relayed", async () => {
    const job = await postJob(team, spec);
    await team.label(job.id, { set: { [REPORT_LABEL]: REPORT_PENDING } });
    const canceled = await cancelJob(team, job.id, "not needed");
    expect(canceled.state).toBe("canceled");
    const delivered: string[] = [];
    await sweepReports(team, async (_origin, _message, key) => delivered.push(key));
    expect(delivered).toEqual([]);
  });
});

describe("answerJob", () => {
  it("refuses a job that asked nothing", async () => {
    const job = await postJob(team, spec);
    await expect(answerJob(team, job.id, "red")).rejects.toThrow(/not waiting for an answer/);
  });

  it("passes the answer on and returns the job to the queue", async () => {
    const job = await postJob(team, spec);
    const claim = await claimAs(worker);
    await claim.block("Which color?", { kind: "needs_input" });
    const answered = await answerJob(team, job.id, "Red and green.");
    expect(answered.state).toBe("ready");
    const { log } = await readJob(team, job.id);
    expect(log.at(-1)?.text).toContain("Red and green.");
    expect((await claimAs(worker)).task.id).toBe(job.id);
  });
});

describe("sweepReports", () => {
  it("delivers each settled job once, to its thread, then clears the label", async () => {
    const job = await postJob(team, spec);
    const claim = await claimAs(worker);
    await worker.reply(job.id, "**Done.** Draft PR: https://github.com/x/y/pull/1\n\nAdded snow.");
    await worker.label(job.id, { set: { [REPORT_LABEL]: REPORT_PENDING } });
    await claim.complete("Draft PR: https://github.com/x/y/pull/1");

    const sent: { origin: unknown; message: string; key: string }[] = [];
    const first = await sweepReports(team, async (origin, message, key) =>
      sent.push({ origin, message, key }),
    );
    expect(first.delivered).toEqual([job.id]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.origin).toEqual(spec.origin);
    expect(sent[0]?.message).toContain("is completed");
    expect(sent[0]?.message).toContain("https://github.com/x/y/pull/1");
    expect(sent[0]?.message).toContain("Added snow.");
    expect(sent[0]?.key).toBe(`job:${job.id}:completed:1`);

    const second = await sweepReports(team, async () => sent.push({ origin: null, message: "", key: "" }));
    expect(second.delivered).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("keeps the label when delivery fails, so the next sweep retries", async () => {
    const job = await postJob(team, spec);
    const claim = await claimAs(worker);
    await worker.label(job.id, { set: { [REPORT_LABEL]: REPORT_PENDING } });
    await claim.fail("claude exited 1");

    const failed = await sweepReports(team, async () => {
      throw new Error("slack is down");
    });
    expect(failed.failed).toEqual([{ id: job.id, error: "slack is down" }]);

    const keys: string[] = [];
    const retried = await sweepReports(team, async (_origin, _message, key) => keys.push(key));
    expect(retried.delivered).toEqual([job.id]);
    expect(keys).toEqual([`job:${job.id}:failed:1`]);
  });

  it("skips a job whose label outlived its claim until it settles again", async () => {
    const job = await postJob(team, spec);
    const claim = await claimAs(worker);
    await worker.label(job.id, { set: { [REPORT_LABEL]: REPORT_PENDING } });
    await claim.release();
    const result = await sweepReports(team, async () => {
      throw new Error("must not deliver");
    });
    expect(result).toEqual({ delivered: [], skipped: [job.id], failed: [] });
  });

  it("clears a job that has nowhere to report", async () => {
    const job = await postJob(team, { ...spec, origin: undefined });
    const claim = await claimAs(worker);
    await worker.label(job.id, { set: { [REPORT_LABEL]: REPORT_PENDING } });
    await claim.complete("done");
    let calls = 0;
    const result = await sweepReports(team, async () => calls++);
    expect(result.delivered).toEqual([job.id]);
    expect(calls).toBe(0);
  });
});

describe("reportMessage", () => {
  const job = {
    id: "7",
    state: "blocked",
    title: "t",
    repo: "r",
    kind: "change",
    runsOn: "claude opus/high",
    heldBy: null,
    result: null,
    reason: null,
    question: "Which color?",
    createdAt: "",
    origin: undefined,
  };

  it("tells robdog to relay a question and how to answer it", () => {
    const message = reportMessage(job, "");
    expect(message).toContain("The worker asks: Which color?");
    expect(message).toContain("answer_job");
  });

  it("clips a long report", () => {
    const message = reportMessage({ ...job, state: "completed", question: null }, "x".repeat(10_000));
    expect(message).toContain("[report clipped]");
    expect(message.length).toBeLessThan(7_000);
  });
});
