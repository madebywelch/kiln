# Field notes

Facts about the services kiln runs on, found against the real thing rather than the fakes. Each cost debugging time once. Check here before rediscovering one.

## boat.dev

- Kept work needs the account's snapshots setting on and zero data retention off. With snapshots off, creating a machine with `snapshots: true` fails `409 snapshots_off_for_account`, and a stop erases the machine (GET returns 404 right after); kiln falls back to machines without snapshots and logs `machines.snapshots_off`. With zero data retention on, a stop erases data instead of keeping a snapshot. If kept work stops working, check both settings first.
- A resumed machine doesn't run its setup script or create-time `files` again, and its processes are gone after about 10 minutes stopped. It stays on the environment version it started with unless upgraded (`POST /environments/{id}/upgrade {agentIds}`).
- A per-machine `env` is exported into every login shell on the machine, so worker credentials never go there.
- A new environment starts with every pass switched on; kiln's secret environments turn all but secrets off.
- `POST /environments` doesn't return the environment it made; read it back by listing.
- `envContents` double-quotes values that contain spaces or symbols.
- kiln's key needs `environment.write` to manage secret groups; without it, environment writes fail with 403. An API key can't delete machines it didn't create.
- Cold start to a ready worker: about 21 seconds.

## agent37 (the factory era)

- Its exec API is synchronous, caps output at 512 KB, and doesn't stream. The factory ran the job under `setsid` and polled base64 chunks of 160 KB.
- The stock image runs under gVisor. Creating an instance needs a day of balance in the wallet.
- Never touch instances kiln did not create.

## Claude Code

- It writes its session `.jsonl` even when the first model call fails, so `--resume` has a session after a 429 on the first request.

## Vercel

- Sensitive environment variables can't be pulled: `vercel env pull` gives a placeholder. Local runs that need one (the inference endpoint, for evals) take it in `.env.local` by hand.
- Vercel CLI 67 ships as a native binary and takes an environment as `--environment`, not a bare word after the name.
- Vercel Sandbox defaults to 2 vCPUs and 4 GB when eve sets no size. Provisioned memory is billed for as long as a sandbox runs (about $0.021 per GB-hour), whether or not it does anything. Each stopped sandbox keeps a snapshot of its disk (about 295 MB for the agent's) for 30 days, billed per GB-day.
- The `vercel logs` window is short (about 12 hours on Pro). Use `--environment production --since 12h --json`.

## eve

- A dynamic schedule's firing (`tasks`) always starts a new session, even when it posts into an existing thread.
- eve names a Vercel sandbox after its session ID, so a new session means a new sandbox.
- Its generated `schedule__<name>__list` keeps one-time schedules that already fired, as active. kiln's `list_tasks` lists what is still to come and deletes the spent ones.
- `decide()` with no model uses a Gateway model. Channel screening (`agent/lib/ambient.ts`) still does, as does voice-note transcription.
- Its MCP client (the bundled `@ai-sdk/mcp`) never follows a redirect. A connection whose server redirects fails to load its tools with `fetch failed`; only the function's log (`failed to load connection tools`) shows the cause, `unexpected redirect`. A server's `url` must be its final address. Mem0's is `https://mcp.mem0.ai/mcp/`: an authenticated request to `/mcp` is redirected there, but a bad key gets its 401 first, so probing with a fake key doesn't show it.

## Anthropic web search

- Search results (`encrypted_content`) and citations of them (`encrypted_index`) are encrypted for the account that ran the search. An endpoint that spreads requests over several accounts refuses a later turn that lands on another one. `agent/lib/search-history.ts` resends that turn with earlier searches as text.

## Models in evals

- Eval stubs must echo what was asked for. A model given a stubbed result that contradicts its request may call the tool again.
- Ambiguous prompt wording fails on the weaker model first. Wording that names the tool fixes it ("propose the edit" was read as "describe it in prose").
- Seen on cheap models: a tool call written as plain text, an empty final turn, a plain-text answer instead of the tool that sends it.
- Every tool that leaves the process needs a stub in `evals/stubs.ts`: an unstubbed one once read a real board through the developer's own login.
