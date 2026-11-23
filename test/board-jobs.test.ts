import { type Board, board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { beforeEach, describe, expect, it } from "vitest";
import {
  answerJob,
  cancelJob,
  listJobs,
  MAX_REPORT_RETRIES,
  postJob,
  REPORT_AFTER_LABEL,
  REPORT_RETRY_LABEL,
  readJob,
  reportBackoffMs,
  reportMessage,
  resolveJobId,
  resumeAfterSecrets,
  retryJob,
  retryReport,
  sweepReports,
} from "../lib/board-jobs.ts";
import {
  INFERENCE_KIND,
  JOBS_CHANNEL,
  type JobSpec,
  KEPT_UNTIL_LABEL,
  REPORT_LABEL,
  REPORT_PENDING,
  RESUME_LABEL,
} from "../lib/jobs.ts";
import { FAILED_STARTS_LABEL } from "../lib/machines.ts";

const spec: JobSpec = {
  repo: "web",
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
    label: { kiln: "job" },
    from: ["board:client"],
  });
  if (!claim) throw new Error("nothing to claim");
  return claim;
}

describe("posting and reading jobs", () => {
  it("attaches the job's files to its task, byte for byte, where a worker finds them", async () => {
    const job = await postJob(team, spec, [
      { name: "favicon.ico", bytes: new Uint8Array([0, 0, 1, 0]) },
      { name: "data.bin", bytes: new Uint8Array([255, 254]) },
    ]);
    const claim = await claimAs(worker);
    expect(claim.task.id).toBe(job.id);
    expect(claim.task.attachments.map((attachment) => attachment.name)).toEqual(["favicon.ico", "data.bin"]);
    const second = claim.task.attachments[1];
    const bytes = new Uint8Array(await (await worker.download(second?.id ?? "")).arrayBuffer());
    expect([...bytes]).toEqual([255, 254]);
  });

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
      label: { kiln: "job", harness: "claude" },
      from: ["board:client"],
    });
    expect(claim?.task.id).toBe(job.id);
    const codex = await team.as("codex-1").tasks.claim({
      channel: JOBS_CHANNEL,
      label: { kiln: "job", harness: "codex" },
      from: ["board:client"],
    });
    expect(codex).toBeNull();
  });

  it("lists jobs and skips foreign tasks in the channel", async () => {
    await postJob(team, spec);
    await team.tasks.create(JOBS_CHANNEL, { text: "someone else's task", labels: { kiln: "job" } });
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

  it("keeps the worker's files before the agent's message, and names them as unposted", async () => {
    const job = await postJob(team, spec);
    const claim = await claimAs(worker);
    const shot = await worker.upload({ data: new Uint8Array([1, 2, 3]), name: "home.png" });
    await worker.reply(job.id, { text: "**Done.** Screenshot attached.", attachments: [shot] });
    await worker.label(job.id, { set: { [REPORT_LABEL]: REPORT_PENDING } });
    await claim.complete("Screenshot attached.");

    const events: string[] = [];
    await sweepReports(
      team,
      async (_origin, message) => events.push(`message: ${message}`),
      async (kept, file) => events.push(`file ${file.name} [${[...file.bytes].join(",")}] of ${kept.id}`),
    );
    expect(events[0]).toBe(`file home.png [1,2,3] of ${job.id}`);
    expect(events[1]).toContain(`saved in your drive under jobs/${job.id}/ and not posted: home.png`);
  });

  it("keeps the files of a job with no Slack thread, and tells no one", async () => {
    const job = await postJob(team, { ...spec, origin: undefined });
    const claim = await claimAs(worker);
    const log = await worker.upload({ data: new Uint8Array([7]), name: "run.log" });
    await worker.reply(job.id, { text: "**Done.**", attachments: [log] });
    await worker.label(job.id, { set: { [REPORT_LABEL]: REPORT_PENDING } });
    await claim.complete("Done.");

    const kept: string[] = [];
    const messages: string[] = [];
    const result = await sweepReports(
      team,
      async (_origin, message) => messages.push(message),
      async (keptJob, file) => kept.push(`${keptJob.id}/${file.name}`),
    );
    expect(kept).toEqual([`${job.id}/run.log`]);
    expect(messages).toEqual([]);
    expect(result.delivered).toEqual([job.id]);
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

  it("drops the label from a job canceled while its worker settled it, and from tasks it can't read", async () => {
    const job = await postJob(team, spec);
    await claimAs(worker);
    await worker.label(job.id, { set: { [REPORT_LABEL]: REPORT_PENDING } });
    await team.tasks.cancel(job.id, "not needed");
    const old = await team.tasks.create(JOBS_CHANNEL, {
      text: "## Old\n\nfrom before a rename",
      labels: { other: "job", [REPORT_LABEL]: REPORT_PENDING },
    });

    const result = await sweepReports(team, async () => {
      throw new Error("must not deliver");
    });
    expect(result.skipped.sort()).toEqual([job.id, old.task.id].sort());
    expect(result.failed).toEqual([]);
    const again = await sweepReports(team, async () => {
      throw new Error("must not deliver");
    });
    expect(again).toEqual({ delivered: [], skipped: [], failed: [] });
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

describe("resumeAfterSecrets", () => {
  async function pausedJob() {
    const job = await postJob(team, spec);
    const claim = await worker.tasks.claim(job.id, { lease: 60 });
    await team.label(job.id, {
      set: { needs_secrets: "LINEAR_API_KEY,DATABASE_URL", [REPORT_LABEL]: REPORT_PENDING },
    });
    await claim.block("Set LINEAR_API_KEY, DATABASE_URL", { kind: "needs_secret" });
    return job;
  }

  it("keeps the job paused while the repo still lacks one of its secrets", async () => {
    const job = await pausedJob();
    expect(await resumeAfterSecrets(team, job.id, ["LINEAR_API_KEY"])).toEqual({
      resumed: false,
      missing: ["DATABASE_URL"],
    });
    expect((await team.thread(job.id, { limit: 1 })).message.task?.state).toBe("blocked");
  });

  it("resumes the job once the repo has them all, with nothing left to report", async () => {
    const job = await pausedJob();
    expect(await resumeAfterSecrets(team, job.id, ["DATABASE_URL", "LINEAR_API_KEY", "OTHER"])).toEqual({
      resumed: true,
      missing: [],
    });
    const { message } = await team.thread(job.id, { limit: 1 });
    expect(message.task?.state).toBe("ready");
    expect(message.labels.needs_secrets).toBeUndefined();
    expect(message.labels[REPORT_LABEL]).toBeUndefined();
  });

  it("leaves a job that isn't paused for secrets alone", async () => {
    const job = await postJob(team, spec);
    expect(await resumeAfterSecrets(team, job.id, ["LINEAR_API_KEY"])).toBeUndefined();
  });
});

describe("reportMessage", () => {
  const job = {
    id: "7",
    ref: "7",
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
    secretsNeeded: null,
    waitingForInference: false,
    workKept: false,
    keptUntil: null,
  };

  it("tells the agent to relay a question and how to answer it", () => {
    const message = reportMessage(job, "");
    expect(message).toContain("The worker asks: Which color?");
    expect(message).toContain("answer_job");
  });

  it("tells the agent to ask for each missing secret with the job, and that saving resumes it", () => {
    const message = reportMessage({ ...job, secretsNeeded: ["LINEAR_API_KEY"] }, "");
    expect(message).toContain("paused until r has these secrets: LINEAR_API_KEY");
    expect(message).toContain('request_secret for each one with job "#7"');
    expect(message).not.toContain("answer_job");
  });

  it("clips a long report", () => {
    const message = reportMessage({ ...job, state: "completed", question: null }, "x".repeat(10_000));
    expect(message).toContain("[report clipped]");
    expect(message.length).toBeLessThan(7_000);
  });
});

describe("resolveJobId", () => {
  it("finds a job by its short reference, with or without #, and passes a full ID through", async () => {
    const job = await postJob(team, spec);
    expect(job.ref).toMatch(/^[0-9a-f]{8}$|^\d+$/);
    expect(await resolveJobId(team, `#${job.ref}`)).toBe(job.id);
    expect(await resolveJobId(team, job.ref)).toBe(job.id);
    expect(await resolveJobId(team, "msg_whatever_1")).toBe("msg_whatever_1");
    await expect(resolveJobId(team, "#deadbeef")).rejects.toThrow(/no job #deadbeef/);
  });
});

describe("a report whose turn failed", () => {
  async function settledJob() {
    const job = await postJob(team, spec);
    const claim = await claimAs(worker);
    await worker.reply(job.id, "**Done.** Added snow.");
    await worker.label(job.id, { set: { [REPORT_LABEL]: REPORT_PENDING } });
    await claim.complete("Added snow.");
    return job;
  }

  it("goes back in the outbox, waits out its backoff, then is handed over again under a new key", async () => {
    const job = await settledJob();
    const keys: string[] = [];
    const deliver = async (_origin: unknown, _message: string, key: string, jobId: string) => {
      expect(jobId).toBe(job.id);
      keys.push(key);
    };
    const t0 = Date.parse("2026-11-22T22:00:00Z");
    await sweepReports(team, deliver, undefined, t0);
    expect(await retryReport(team, job.id, t0)).toBe("retrying");
    const { message } = await team.thread(job.id, { limit: 1 });
    expect(message.labels).toMatchObject({
      [REPORT_LABEL]: REPORT_PENDING,
      [REPORT_RETRY_LABEL]: "1",
      [REPORT_AFTER_LABEL]: "2026-11-22T22:01:00.000Z",
    });

    const early = await sweepReports(team, deliver, undefined, t0 + 30_000);
    expect(early.skipped).toEqual([job.id]);
    const due = await sweepReports(team, deliver, undefined, t0 + 60_000);
    expect(due.delivered).toEqual([job.id]);
    expect(keys).toEqual([`job:${job.id}:completed:1`, `job:${job.id}:completed:1:retry1`]);
  });

  it("backs off 1, 2, 4, 8, 16, then 30 minutes, and gives up after a day of tries", async () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((retry) => reportBackoffMs(retry) / 60_000)).toEqual([
      1, 2, 4, 8, 16, 30, 30,
    ]);
    const job = await settledJob();
    await team.label(job.id, { set: { [REPORT_RETRY_LABEL]: String(MAX_REPORT_RETRIES) } });
    expect(await retryReport(team, job.id)).toBe("gave_up");
  });
});

describe("retrying a failed job", () => {
  it("runs it again in place, as it was, with the last run's report and failed starts cleared", async () => {
    const job = await postJob(team, spec, [{ name: "logo.svg", bytes: new Uint8Array([1]) }]);
    const claim = await claimAs(worker);
    await worker.reply(job.id, "**Failed:** claude exited 1: API Error: Request rejected (429)");
    await worker.label(job.id, { set: { [REPORT_LABEL]: REPORT_PENDING } });
    await claim.fail("claude exited 1: API Error: Request rejected (429)");
    await team.label(job.id, { set: { [FAILED_STARTS_LABEL]: "2", [REPORT_RETRY_LABEL]: "3" } });

    const retried = await retryJob(team, job.id);
    expect(retried).toMatchObject({ id: job.id, state: "ready", runsOn: "claude opus/high" });
    const { message } = await team.thread(job.id, { limit: 1 });
    for (const label of [REPORT_LABEL, REPORT_RETRY_LABEL, FAILED_STARTS_LABEL]) {
      expect(message.labels[label]).toBeUndefined();
    }
    const { brief, files } = await readJob(team, job.id);
    expect(brief).toBe(spec.brief);
    expect(files).toEqual(["logo.svg"]);
  });

  it("refuses a job that hasn't failed", async () => {
    const job = await postJob(team, spec);
    await expect(retryJob(team, job.id)).rejects.toThrow(/only a failed job can be retried; #.+ is ready/);
  });
});

describe("jobs waiting for inference", () => {
  it("won't take an answer for a job that waits for the endpoint, not a person", async () => {
    const job = await postJob(team, spec);
    const claim = await claimAs(worker);
    await claim.block("Waiting for inference: rate limited until about 01:30", { kind: INFERENCE_KIND });
    const view = (await readJob(team, job.id)).job;
    expect(view).toMatchObject({ state: "blocked", waitingForInference: true, workKept: false });
    await expect(answerJob(team, job.id, "go on")).rejects.toThrow(/waits for inference, not for an answer/);
  });

  it("says whether a failed job's work is kept, and a retry keeps it while clearing its expiry", async () => {
    const job = await postJob(team, spec);
    const claim = await claimAs(worker);
    await claim.fail("claude timed out after 180m");
    await team.label(job.id, {
      set: { [RESUME_LABEL]: "ses-1", [KEPT_UNTIL_LABEL]: "2026-11-25T00:00:00.000Z" },
    });
    expect((await readJob(team, job.id)).job).toMatchObject({
      workKept: true,
      keptUntil: "2026-11-25T00:00:00.000Z",
    });
    const retried = await retryJob(team, job.id);
    expect(retried).toMatchObject({ state: "ready", workKept: true, keptUntil: null });
  });
});
