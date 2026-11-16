# Slack

Kiln connects to Slack over Socket Mode: one outbound WebSocket. Kiln needs no public URL and nothing in Slack points at your machine.

## What it does

| | |
|---|---|
| Hears | Direct messages. @mentions. Everything else said in channels it has been invited to, as ambient messages it may or may not answer. Emoji reactions on its own messages. Clicks on buttons and menus in its messages. |
| Sees | The recent messages of the channel, thread, or DM each event came from, read from Slack at the start of the run, with speakers named. Its own latest exchanges from everywhere else it is present. |
| Says | Messages in Markdown. Replies in the thread a message is in, or in a new thread under a top-level message. Emoji reactions. Block Kit layouts. Approval prompts with Approve and Decline buttons. |
| Ignores | Other bots. Edits, deletions, and join notices. Members excluded by `KILN_SLACK_USERS`, if you set it. |

## Set it up

1. Go to <https://api.slack.com/apps>, choose **Create New App**, then **From a manifest**. Pick your workspace and paste this:

   ```yaml
   display_information:
     name: Kiln
     description: Always-on agent
   features:
     app_home:
       home_tab_enabled: false
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
     bot_user:
       display_name: kiln
       always_online: true
   oauth_config:
     scopes:
       bot:
         - app_mentions:read
         - channels:history
         - chat:write
         - groups:history
         - im:history
         - mpim:history
         - reactions:read
         - reactions:write
         - users:read
   settings:
     event_subscriptions:
       bot_events:
         - app_mention
         - message.channels
         - message.groups
         - message.im
         - message.mpim
         - reaction_added
     interactivity:
       is_enabled: true
     org_deploy_enabled: false
     socket_mode_enabled: true
     token_rotation_enabled: false
   ```

2. **Install App** to the workspace. Copy the **Bot User OAuth Token** (`xoxb-...`) from **OAuth & Permissions**.
3. Under **Basic Information**, **App-Level Tokens**, generate a token with the scope `connections:write`. Copy it (`xapp-...`).
4. Set two variables and start kiln:

   ```sh
   KILN_SLACK_BOT_TOKEN=xoxb-...
   KILN_SLACK_APP_TOKEN=xapp-...
   ```

5. DM the bot. The log shows `slack connected`, then `event accepted`, then `delivered`.

To use it in a channel, invite it (`/invite @kiln`).

After changing the manifest of an existing app (new scopes or events), reinstall it from **Install App**. Until then Slack keeps the old permissions; kiln logs which scope is missing and carries on without that context.

## Who it listens to

By default, everyone in the workspace, and they share one agent: one memory, one set of timers, one stream of context. The kiln user is named `slack`. This suits a private workspace. Anyone who can message the bot can instruct it and approve its calls.

`KILN_SLACK_USERS` changes that. It is optional.

| Value | Effect |
|---|---|
| unset | Everyone is heard. All share the kiln user `slack`. |
| `*:team` | Everyone is heard. All share the kiln user `team`. |
| `U0123ABCD:robert` | Only that member is heard. Everyone else is ignored, and logged once. |
| `U0123ABCD:robert,*:team` | That member has their own agent. Everyone else shares another. |

Two kiln users are two separate agents: separate memory, timers, approvals, and context. Isolation is something you opt into.

## When it speaks

- A DM or an @mention is addressed to it. It answers.
- Anything else said in a channel it is in reaches it as an ambient message, with the recent conversation attached. It answers when it is spoken to by name or the message continues an exchange it is part of, and when it holds something the conversation plainly needs. Otherwise it stays silent.
- Every ambient message, or burst of them, costs one model call to make that judgment. In a busy channel that adds up. To stop it for one channel, remove the bot from it. To stop it everywhere, remove `message.channels`, `message.groups`, and `message.mpim` from the manifest; the bot then hears only DMs and @mentions.
- A "yes" said in a channel without addressing the bot never answers an approval.

## Threads

The agent replies where the conversation is.

- A message in a thread is answered in that thread.
- A top-level message is answered beside it. The agent can open a thread under it instead (`start_thread`), which it should do for long or secondary answers.
- The agent can return to an earlier message's thread in a later run, for example when a timer fires for something asked there.
- A timer's result returns to the conversation the timer was set in.
- A message that answers nothing and belongs to no conversation goes to your DM with the bot, if `KILN_SLACK_USERS` maps you to your own kiln user. A shared agent has no single DM; such a message falls through to the webhook or stdout.

## Emoji

- The agent can react to your messages. It uses this to acknowledge without sending a message.
- A reaction you put on one of the agent's messages reaches it as feedback, with the text of the message you reacted to. It never counts as an instruction or an approval.
- Emoji in message text work as anywhere in Slack.

Reactions are delivered when the run ends, together with any reply.

## Block Kit

- Ordinary messages are sent as a `markdown` block, so standard Markdown renders as written: bold, lists, code blocks, tables, links.
- The agent can send its own [Block Kit](https://docs.slack.dev/block-kit) blocks when a layout calls for it. The message text stays as the notification fallback. If Slack refuses the blocks, the text is sent alone.
- A click on a button or a choice in a menu comes back to the agent as an event from you, for example `Clicked "Snooze 1h" (value: 1h)`.
- Approval prompts show the exact call as plain text, never reformatted, with Approve and Decline buttons. After a click the buttons are replaced by the outcome.

## Trust

- By default the workspace is the boundary: its members can instruct the agent. Set `KILN_SLACK_USERS` without a `*` entry to restrict it to named members.
- An approval button works only for members of the kiln user the prompt is for, and only for that prompt.
- What other people say in a channel reaches the model as conversation context. The prompt tells it to treat context as information, not instructions; that is a soft boundary, not a hard one.
- While an approval is open, any other message or click from you declines it. That is the same rule as everywhere else in kiln.
- The bot token can post as the bot anywhere it has been invited. Keep both tokens out of the repository; `.env` is ignored by git.

## Limits

- One connection. Slack allows ten per app; kiln opens one.
- Messages over 11,000 characters are sent as plain text, which Slack may split.
- Files are named in the event (`[attached file: q3.pdf]`) but not read.
- Context is the last 20 messages of the conversation. A thread longer than 200 messages loses its newest end.
- Slack redelivers events it believes were lost. Kiln records each once.
