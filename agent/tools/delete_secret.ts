import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { configuredProjects } from "../../lib/deployment.ts";
import { SECRET_GROUPS } from "../../lib/secrets.ts";
import { deleteBlocks } from "../lib/secret-prompt.ts";
import { slackApi, slackHere } from "../lib/slack.ts";

export default defineDynamic(() => {
  const projects = configuredProjects();
  if (!projects) return null;
  const repoKeys = Object.keys(projects) as [string, ...string[]];

  return defineTool({
    description:
      "Offer to delete a secret from a repo's or project's group, such as a test value, one saved in the wrong group, " +
      "or one that was rotated away. Posts a Delete button in this thread; it deletes only when a person clicks it and " +
      "confirms, and the thread hears when it's gone. Jobs already running keep what they started with.",
    inputSchema: z.object({
      repo: z.enum(repoKeys),
      group: z.enum(SECRET_GROUPS),
      name: z.string().describe("The secret's name, as list_secrets shows it."),
      why: z.string().max(300).describe("One sentence on why it should go, shown above the button."),
    }),
    label: { start: ({ repo, group, name }) => `Offer to delete ${name} from ${repo}'s ${group} secrets` },
    async execute({ repo, group, name, why }, ctx) {
      const here = slackHere(ctx);
      if (!here) throw new Error("not in Slack: a secret can only be deleted from a Slack conversation");
      await slackApi(
        "chat.postMessage",
        {
          channel: here.channelId,
          ...(here.threadTs ? { thread_ts: here.threadTs } : {}),
          text: `Delete ${name} from ${repo}'s ${group} secrets?`,
          blocks: deleteBlocks({ repo, group, name }, why),
        },
        here.teamId,
      );
      return { offered: name, repo, group };
    },
  });
});
