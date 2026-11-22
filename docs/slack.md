# Slack

The agent receives Slack's Events API at `https://<deployment>/eve/v1/slack` and interactivity (buttons and forms) at `https://<deployment>/slack/interactivity`. The interactivity route handles kiln's repo-secret form itself, because eve ignores forms it didn't create, and forwards every other payload unchanged to `/eve/v1/slack`. Slack signs each request; both routes verify it with the signing secret.

## Create the app

1. Deploy the agent once (`pnpm run deploy`) and note its production URL.
2. At <https://api.slack.com/apps>, choose **Create New App**, then **From a manifest**. Paste this, with your URL in both places:

   ```yaml
   display_information:
     name: eve
     description: AI teammate
   features:
     app_home:
       home_tab_enabled: false
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
     bot_user:
       display_name: eve
       always_online: true
   oauth_config:
     scopes:
       bot:
         - app_mentions:read
         - channels:history
         - channels:read
         - chat:write
         - files:read
         - files:write
         - groups:history
         - groups:read
         - im:history
         - im:read
         - im:write
         - mpim:history
         - mpim:read
         - reactions:read
         - reactions:write
         - users:read
   settings:
     event_subscriptions:
       request_url: https://YOUR-AGENT.vercel.app/eve/v1/slack
       bot_events:
         - app_mention
         - message.channels
         - message.groups
         - message.im
         - message.mpim
     interactivity:
       is_enabled: true
       request_url: https://YOUR-AGENT.vercel.app/slack/interactivity
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

3. **Install App** to the workspace. Copy the **Bot User OAuth Token** (`xoxb-...`) and, from **Basic Information**, the **Signing Secret**.
4. Set both on the project and redeploy:

   ```sh
   vercel env add SLACK_BOT_TOKEN production
   vercel env add SLACK_SIGNING_SECRET production
   pnpm run deploy
   ```

5. DM the agent. Invite it to channels with `/invite @eve` (your agent's name).

An app made before the secret form existed has its interactivity at `/eve/v1/slack`. Change it under **Interactivity & Shortcuts**, **Request URL**, to `https://<deployment>/slack/interactivity`.

To let Vercel Connect hold the token instead, create a Slack connector with triggers at `/eve/v1/slack`, give it the scopes and events above, and set `SLACK_CONNECTOR` to its UID in place of the two variables. The secret form still needs `SLACK_SIGNING_SECRET` to verify its requests; without it, the interactivity route forwards everything to eve and the form doesn't open.

After changing scopes or events, reinstall the app from **Install App**.

## How the agent decides to speak

| Message | The agent |
|---|---|
| A DM, an @mention | Always answers. A top-level one starts a thread, and the agent gets the channel's last 15 messages as context. |
| A reply in a thread the agent is part of | Sees it, answers only if it is meant for it, else stays silent. |
| A reply in a thread the agent is not part of | Doesn't see it, unless mentioned. `slack_history` can read the thread later. |
| A top-level message in a channel the agent is in | A decision model screens it (fails open). If it passes, the agent sees it with the channel's recent messages and takes part only if it has something useful to add. Its name in the text, or an audio attachment, skips the screen. |
| A message from a bot | Ignored. |

Every message that reaches the agent carries the conversation's name, such as "#guaca" or "a direct message", looked up once per channel with `conversations.info` (`channels:read`, `groups:read`). eve itself passes only the channel's ID, and a channel named after a project tells the agent which project a message is about.

A silent turn leaves no trace in Slack: no status, no reply. Screening decisions are logged as `ambient.screen` with the probability and outcome, never the text.

Every top-level message in a busy channel costs one screening call, and the ones that pass cost a turn. Remove the agent from channels where that isn't worth it.

## Where replies go

- A reply goes in the thread of the message it answers.
- `slack_post` posts top-level in the channel, in another thread, or in another channel, with Markdown or Block Kit.
- Long replies (over 12,000 characters) are uploaded as a snippet.
- `slack_upload` shares a file: text the agent writes, or a file from its sandbox.
- `slack_react` adds an emoji reaction.

## Files

Files attached to a message reach the agent; a mention without files also gets files posted in the thread since its last mention. They land in the agent's sandbox under `/workspace/.eve/attachments`, so it can read, convert, or analyze them; the sandbox has ImageMagick, zip and unzip, `file`, Python 3, and jq (`agent/sandbox/sandbox.ts`). The sandbox doesn't last, so the agent saves files worth keeping to its drive.

To put a file in a repo, the agent passes it to `start_job` (`files`). It travels as an attachment on the job's Board task, and the worker downloads it into `.kiln/inputs/` before the CLI starts; the brief says where it goes. Files a job returns are posted in the thread and saved in the agent's drive under `jobs/<id>/`. Up to 10 files, 25 MB each, either way.

Voice clips and other audio reach the model as a file label, not sound. The agent transcribes them with `transcribe_audio` (AI Gateway, `KILN_TRANSCRIPTION_MODEL`) before deciding whether to answer, then treats the transcript as what was said. The screen never drops a message with audio, because it reads text only. Each clip costs one transcription call, about $0.003 a minute on the default model. Transcriptions are logged as `audio.transcribed` with size, duration, and character count, never the words; failures as `audio.transcribe_failed`.

## Watching a conversation

Every turn is traced to Vercel Agent Runs: in the Vercel dashboard, open the project, then **Observability → Agent Runs**. Each Slack thread is a session; open one to see each turn's model calls, the instructions and context the model saw, its reasoning and replies, and every tool call with its input and result. Traces are kept 30 days.

Tracing needs a sampling rule on the project, set once: `vercel traces config set 100 --environment production`. Content is recorded in every conversation, DMs and private channels included (`agent/instrumentation/otel.ts`); narrow that policy if the workspace is shared with people who shouldn't have their DMs in traces. From the terminal, `vercel traces search --project <project>` lists recent spans and `vercel traces inspect <id>` shows one trace.

The routing decisions before a turn (`slack.route`, `ambient.screen`) are in the function logs, not the traces: `vercel logs --environment production`.
