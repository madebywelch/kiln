# Slack

robdog receives Slack's Events API and interactivity at `https://<deployment>/eve/v1/slack`. Slack signs each request; the channel verifies it with the signing secret.

## Create the app

1. Deploy robdog once (`pnpm exec eve deploy`) and note its production URL.
2. At <https://api.slack.com/apps>, choose **Create New App**, then **From a manifest**. Paste this, with your URL in both places:

   ```yaml
   display_information:
     name: robdog
     description: AI teammate
   features:
     app_home:
       home_tab_enabled: false
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
     bot_user:
       display_name: robdog
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
       request_url: https://YOUR-ROBDOG.vercel.app/eve/v1/slack
       bot_events:
         - app_mention
         - message.channels
         - message.groups
         - message.im
         - message.mpim
     interactivity:
       is_enabled: true
       request_url: https://YOUR-ROBDOG.vercel.app/eve/v1/slack
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

3. **Install App** to the workspace. Copy the **Bot User OAuth Token** (`xoxb-...`) and, from **Basic Information**, the **Signing Secret**.
4. Set both on the project and redeploy:

   ```sh
   vercel env add SLACK_BOT_TOKEN production
   vercel env add SLACK_SIGNING_SECRET production
   pnpm exec eve deploy
   ```

5. DM robdog. Invite it to channels with `/invite @robdog`.

To let Vercel Connect hold the token instead, create a Slack connector with triggers at `/eve/v1/slack`, give it the scopes and events above, and set `SLACK_CONNECTOR` to its UID in place of the two variables.

After changing scopes or events, reinstall the app from **Install App**.

## How robdog decides to speak

| Message | robdog |
|---|---|
| A DM, an @mention | Always answers. A top-level one starts a thread, and robdog gets the channel's last 15 messages as context. |
| A reply in a thread robdog is part of | Sees it, answers only if it is meant for it, else stays silent. |
| A reply in a thread robdog is not part of | Doesn't see it, unless mentioned. `slack_history` can read the thread later. |
| A top-level message in a channel robdog is in | A decision model screens it (fails open). If it passes, robdog sees it with the channel's recent messages and takes part only if it has something useful to add. Its name in the text skips the screen. |
| A message from a bot | Ignored. |

A silent turn leaves no trace in Slack: no status, no reply. Screening decisions are logged as `ambient.screen` with the probability and outcome, never the text.

Every top-level message in a busy channel costs one screening call, and the ones that pass cost a turn. Remove robdog from channels where that isn't worth it.

## Where replies go

- A reply goes in the thread of the message it answers.
- `slack_post` posts top-level in the channel, in another thread, or in another channel, with Markdown or Block Kit.
- Long replies (over 12,000 characters) are uploaded as a snippet.
- `slack_upload` shares a file: text robdog writes, or a file from its sandbox.
- `slack_react` adds an emoji reaction.

## Files

Files attached to a message reach robdog; a mention without files also gets files posted in the thread since its last mention. They land in robdog's sandbox under `/workspace/.eve/attachments`, so it can read, convert, or analyze them. Files are not passed on to jobs; describe what a worker needs in the brief, or commit the file.
