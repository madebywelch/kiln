import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DELETE_ACTION_ID,
  deleteBlocks,
  handleInteractivity,
  type InteractivityDeps,
  MODAL_CALLBACK_ID,
  OPEN_ACTION_ID,
  requestBlocks,
  type SecretDeletion,
  type SecretRequest,
  secretEditors,
  verifySlackSignature,
} from "../agent/lib/secret-prompt.ts";

const SECRET = "signing-secret";
const NOW = 1_800_000_000;

function signed(payload: unknown, at = NOW, secret = SECRET): Request {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${at}:${body}`).digest("hex")}`;
  return new Request("https://agent.example/slack/interactivity", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(at),
      "x-slack-signature": signature,
    },
    body,
  });
}

function harness(overrides: Partial<InteractivityDeps> = {}) {
  const calls = {
    views: [] as Record<string, unknown>[],
    secrets: [] as [SecretRequest, string, string][],
    deleted: [] as SecretDeletion[],
    posts: [] as string[],
    resumed: [] as [string, string, string][],
    forwarded: 0,
    logs: [] as { event: string; fields?: Record<string, unknown> }[],
    pending: [] as Promise<unknown>[],
  };
  const deps: InteractivityDeps = {
    signingSecret: SECRET,
    isRepo: (repo) => repo === "web",
    mayEdit: secretEditors("U_ADMIN, U_OTHER"),
    openView: async (_trigger, view) => {
      calls.views.push(view);
    },
    setSecret: async (request, value, savedBy) => {
      calls.secrets.push([request, value, savedBy]);
    },
    deleteSecret: async (deletion) => {
      calls.deleted.push(deletion);
      return deletion.name !== "GONE";
    },
    postMessage: async (_channel, _thread, text) => {
      calls.posts.push(text);
    },
    resumeJob: async (job, repo, group) => {
      calls.resumed.push([job, repo, group]);
      return `Job #${job} is resuming.`;
    },
    forward: async () => {
      calls.forwarded++;
      return new Response("eve", { status: 200 });
    },
    waitUntil: (work) => {
      calls.pending.push(work);
    },
    log: (event, fields) => calls.logs.push({ event, ...(fields ? { fields } : {}) }),
    nowSeconds: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}

const request: SecretRequest = {
  repo: "web",
  group: "staging",
  name: "LINEAR_API_KEY",
  description: "Linear, for its MCP server.",
};

const click = (user: string, value = JSON.stringify(request)) => ({
  type: "block_actions",
  trigger_id: "trig",
  user: { id: user },
  channel: { id: "C1" },
  message: { ts: "2.0", thread_ts: "1.0" },
  actions: [{ action_id: OPEN_ACTION_ID, value }],
});

const submit = (user: string, value: string) => ({
  type: "view_submission",
  user: { id: user },
  view: {
    callback_id: MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({ ...request, channel: "C1", thread: "1.0" }),
    state: { values: { secret: { value: { value } } } },
  },
});

describe("secretEditors", () => {
  it("lets anyone set secrets while KILN_SECRET_ADMINS is unset, and only those listed once it is", () => {
    expect(secretEditors(undefined)("U_ANYONE")).toBe(true);
    expect(secretEditors(" ")("U_ANYONE")).toBe(true);
    const listed = secretEditors("U_ADMIN, U_OTHER");
    expect(listed("U_OTHER")).toBe(true);
    expect(listed("U_ANYONE")).toBe(false);
  });
});

describe("verifySlackSignature", () => {
  it("accepts Slack's signature and refuses a wrong secret, a stale request, or a missing header", () => {
    const body = "payload=x";
    const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${NOW}:${body}`).digest("hex")}`;
    expect(verifySlackSignature(body, String(NOW), sig, SECRET, NOW)).toBe(true);
    expect(verifySlackSignature(body, String(NOW), sig, "other", NOW)).toBe(false);
    expect(verifySlackSignature(body, String(NOW), sig, SECRET, NOW + 301)).toBe(false);
    expect(verifySlackSignature(body, null, sig, SECRET, NOW)).toBe(false);
    expect(verifySlackSignature(`${body}tampered`, String(NOW), sig, SECRET, NOW)).toBe(false);
  });
});

describe("handleInteractivity", () => {
  it("refuses an unsigned request without forwarding it", async () => {
    const { deps, calls } = harness();
    const response = await handleInteractivity(signed(click("U_ADMIN"), NOW, "forged"), deps);
    expect(response.status).toBe(401);
    expect(calls.forwarded).toBe(0);
  });

  it("opens the secret form for an operator", async () => {
    const { deps, calls } = harness();
    const response = await handleInteractivity(signed(click("U_ADMIN")), deps);
    expect(response.status).toBe(200);
    expect(calls.views[0]).toMatchObject({ callback_id: MODAL_CALLBACK_ID });
    expect(JSON.parse(String(calls.views[0]?.private_metadata))).toEqual({
      ...request,
      channel: "C1",
      thread: "1.0",
    });
  });

  it("tells anyone else they can't, with the ID an operator would allow", async () => {
    const { deps, calls } = harness();
    await handleInteractivity(signed(click("U_STRANGER")), deps);
    expect(calls.views[0]?.callback_id).toBeUndefined();
    expect(JSON.stringify(calls.views[0])).toContain("U_STRANGER");
  });

  it("refuses a button naming a repo kiln doesn't know", async () => {
    const { deps, calls } = harness();
    await handleInteractivity(
      signed(click("U_ADMIN", JSON.stringify({ ...request, repo: "elsewhere" }))),
      deps,
    );
    expect(JSON.stringify(calls.views[0])).toContain("no longer names a kiln repo");
  });

  it("saves a submitted value, closes the form, and tells the thread without the value", async () => {
    const { deps, calls } = harness();
    const response = await handleInteractivity(signed(submit("U_ADMIN", " lin_secret ")), deps);
    expect(await response.json()).toEqual({ response_action: "clear" });
    expect(calls.secrets).toEqual([[request, "lin_secret", "U_ADMIN"]]);
    await Promise.all(calls.pending);
    expect(calls.posts).toEqual([
      "<@U_ADMIN> set `LINEAR_API_KEY` in *web*'s *staging* secrets. Jobs started with its staging secrets get the new value.",
    ]);
    expect(JSON.stringify(calls.logs)).not.toContain("lin_secret");
  });

  it("resumes the paused job the secret was asked for, and says so", async () => {
    const { deps, calls } = harness();
    const payload = submit("U_ADMIN", "lin_secret");
    payload.view.private_metadata = JSON.stringify({ ...request, channel: "C1", thread: "1.0", job: "813" });
    await handleInteractivity(signed(payload), deps);
    await Promise.all(calls.pending);
    expect(calls.resumed).toEqual([["813", "web", "staging"]]);
    expect(calls.posts).toEqual([
      "<@U_ADMIN> set `LINEAR_API_KEY` in *web*'s *staging* secrets. Job #813 is resuming.",
    ]);
  });

  it("carries the job from the button into the form", async () => {
    const { deps, calls } = harness();
    const value = JSON.stringify({ ...request, job: "813" });
    await handleInteractivity(signed(click("U_ADMIN", value)), deps);
    expect(JSON.parse(String(calls.views[0]?.private_metadata)).job).toBe("813");
  });

  it("refuses a submission from someone who isn't an operator", async () => {
    const { deps, calls } = harness();
    const response = await handleInteractivity(signed(submit("U_STRANGER", "x")), deps);
    expect(await response.json()).toMatchObject({ response_action: "errors" });
    expect(calls.secrets).toEqual([]);
  });

  it("shows boat's refusal in the form instead of closing it", async () => {
    const { deps } = harness({
      setSecret: async () => {
        throw new Error("the value must be one line");
      },
    });
    const response = await handleInteractivity(signed(submit("U_ADMIN", "x")), deps);
    expect(await response.json()).toEqual({
      response_action: "errors",
      errors: { secret: "the value must be one line" },
    });
  });

  const remove = (user: string, name = "HELLO_WORLD") => ({
    type: "block_actions",
    user: { id: user },
    channel: { id: "C1" },
    message: { ts: "2.0", thread_ts: "1.0" },
    actions: [
      { action_id: DELETE_ACTION_ID, value: JSON.stringify({ repo: "web", group: "staging", name }) },
    ],
  });

  it("deletes a secret once its confirmed button is clicked, and tells the thread", async () => {
    const { deps, calls } = harness();
    const response = await handleInteractivity(signed(remove("U_ADMIN")), deps);
    expect(response.status).toBe(200);
    await Promise.all(calls.pending);
    expect(calls.deleted).toEqual([{ repo: "web", group: "staging", name: "HELLO_WORLD" }]);
    expect(calls.posts).toEqual([
      "<@U_ADMIN> deleted `HELLO_WORLD` from *web*'s *staging* secrets. Jobs that start now don't have it.",
    ]);
  });

  it("says when there was nothing to delete, and refuses someone who may not edit", async () => {
    const { deps, calls } = harness();
    await handleInteractivity(signed(remove("U_ADMIN", "GONE")), deps);
    await handleInteractivity(signed(remove("U_STRANGER")), deps);
    await Promise.all(calls.pending);
    expect(calls.deleted).toEqual([{ repo: "web", group: "staging", name: "GONE" }]);
    expect(calls.posts[0]).toContain("wasn't in *web*'s *staging* secrets");
    expect(calls.posts[1]).toContain("U_STRANGER");
  });

  it("forwards every other payload to eve unchanged", async () => {
    const { deps, calls } = harness();
    const response = await handleInteractivity(
      signed({
        type: "block_actions",
        trigger_id: "t",
        user: { id: "U_ADMIN" },
        actions: [{ action_id: "eve_input:abc" }],
      }),
      deps,
    );
    expect(await response.text()).toBe("eve");
    expect(calls.forwarded).toBe(1);
  });
});

describe("requestBlocks", () => {
  it("names the repo, the group, the secret, what it is, and where it's stored, with a button carrying no value", () => {
    const blocks = JSON.stringify(requestBlocks({ ...request, expires: "2026-12-01" }));
    expect(blocks).toContain("kiln-web-staging");
    expect(blocks).toContain(OPEN_ACTION_ID);
    expect(blocks).toContain("Linear, for its MCP server.");
    expect(blocks).toContain("Expires 2026-12-01.");
  });
});

describe("deleteBlocks", () => {
  it("asks Slack to confirm before the delete reaches kiln", () => {
    const [, actions] = deleteBlocks(
      { repo: "web", group: "production-read", name: "HELLO_WORLD" },
      "A test value.",
    );
    expect(JSON.stringify(actions)).toContain('"confirm":{');
    expect(JSON.stringify(actions)).toContain("kiln-web-production-read");
  });
});
