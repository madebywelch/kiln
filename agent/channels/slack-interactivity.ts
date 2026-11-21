// Slack's interactivity webhook. Set the Slack app's Interactivity Request URL
// to https://<your agent>/slack/interactivity. kiln's secret button and modal
// are handled here (agent/lib/secret-prompt.ts); every other payload goes on,
// unchanged and still signed, to eve's Slack route.

import { defineChannel, POST } from "eve/channels";
import { setSecret } from "../../lib/secrets.ts";
import { boatClient, log } from "../lib/machines.ts";
import { handleInteractivity, secretEditors } from "../lib/secret-prompt.ts";
import { slackApi } from "../lib/slack.ts";

const FORWARDED_HEADERS = [
  "content-type",
  "x-slack-signature",
  "x-slack-request-timestamp",
  "x-slack-retry-num",
  "x-slack-retry-reason",
];

export default defineChannel({
  routes: [
    POST("/slack/interactivity", (request, { waitUntil }) =>
      handleInteractivity(request, {
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        mayEdit: secretEditors(process.env.KILN_SECRET_ADMINS),
        openView: (triggerId, view) => slackApi("views.open", { trigger_id: triggerId, view }),
        setSecret: async (repo, name, value) => {
          const boat = boatClient();
          if (typeof boat === "string") throw new Error(boat);
          await setSecret(boat, repo, name, value);
        },
        postMessage: (channel, thread, text) =>
          slackApi("chat.postMessage", { channel, text, ...(thread ? { thread_ts: thread } : {}) }),
        forward: async (body, headers) => {
          const forwarded = new Headers();
          for (const name of FORWARDED_HEADERS) {
            const value = headers.get(name);
            if (value) forwarded.set(name, value);
          }
          const response = await fetch(new URL("/eve/v1/slack", request.url), {
            method: "POST",
            headers: forwarded,
            body,
          });
          return new Response(await response.arrayBuffer(), {
            status: response.status,
            headers: { "content-type": response.headers.get("content-type") ?? "text/plain" },
          });
        },
        waitUntil,
        log,
      }),
    ),
  ],
});
