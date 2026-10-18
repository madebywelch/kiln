# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through the repository's
**Security** tab using a
[GitHub private security advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities).
Do not open a public issue, pull request, or discussion for a security problem.

Include the affected version or commit, a minimal reproduction, the impact you
believe is possible, and any relevant logs. Remove tokens, credentials, private
source, and personal data from attachments.

Maintainers will acknowledge a report as soon as practical, investigate, and
coordinate disclosure with you. There is no bug bounty.

## Supported versions

Security fixes target the current `main` branch and the most recent tagged
release. Older releases may receive a fix at the maintainers' discretion.

## Threat model

KILN is a single-host, single-operator control plane. Workflow authors and API
token holders can execute arbitrary code as the service account. That is the
intended model, not a vulnerability.

A workflow with a `sandbox` block executes its commands, agents, and candidate
checks on one remote machine (boat.dev or agent37) dedicated to the run. The
machine is trusted with the run's source code, the node's declared variables,
and the inference key its agents use; it is not trusted by the host.
Everything it returns (archives, Git bundles, command output) is untrusted
input to the daemon. The daemon's own credentials, the provider API key, Codex
credentials, and the provider account's secrets must never reach a machine.

In scope:

- Authentication or signature bypass on the HTTP API, SSE stream, artifact
  download, transcript download, or GitHub webhook.
- Path traversal, symlink escape, or cross-run access to artifacts, transcripts,
  worktrees, or the data directory.
- Publication of files, commits, ancestry, tags, or credentials outside the
  explicitly selected changeset.
- State corruption or privilege escalation caused by malformed workflow YAML,
  API input, or webhook payloads.
- Leakage of bearer tokens, provider keys, Git credentials, Codex
  credentials, or a sandbox provider's API key through logs, artifacts, URLs,
  error responses, or into a remote machine.
- A boat machine created with the account's secrets, command history enabled,
  or without the run's idempotency key; or a run executing on, reading from,
  or deleting another run's machine on either provider.
- Archives, Git bundles, or command output returned by a remote machine
  writing outside the run's checkout and artifact directory, escaping path
  confinement, or altering checkpoint ancestry.

Out of scope:

- Code execution, prompt injection, or data exfiltration by an authorized
  workflow author or token holder.
- A malicious command escaping its process group, closing an inherited lease
  descriptor, or otherwise defeating cooperative cleanup, on the host or
  inside a remote machine.
- A run's own commands or agents reading the credentials present in their
  process environment inside a remote machine (`pass_env` values, the
  OpenRouter key, selected MCP credentials). The machine is one trust domain.
- Availability, isolation, data retention, or billing behavior of the boat.dev
  or agent37 services. Report those to the provider.
- Misconfiguration that exposes the API without TLS, reuses the bearer token as
  a webhook secret, or grants broad cloud credentials to the service account.
- Vulnerabilities in upstream agent runtimes, model providers, Git, GitHub, or
  the host operating system. Report those to the relevant project.

## Hardening expectations

- Run KILN on a dedicated host or container with narrowly scoped credentials.
- Never expose the API over plain HTTP or publish it without authentication.
- Use a random bearer token of at least 32 characters and a separate webhook
  secret.
- Keep the data directory private; it contains source code and captured output.
- Treat `/v1/status`, transcripts, artifacts, and SSE streams as private.
- Give the daemon a boat API key made with the `ci` preset and nothing
  broader; it can only manage machines it created. An agent37 key reaches
  every instance in its workspace, so give KILN a workspace of its own. Use
  dedicated, spend-limited inference and MCP credentials for sandbox
  workflows, since they are present inside the machine.
- Treat a run's machine as holding private source code. Clean up workspaces
  to delete machines promptly; boat keeps a stopped machine's disk for 14
  days and agent37 keeps a deleted instance's backup for seven. Pin
  toolchains and agent versions with a named snapshot or template version
  rather than the provider's moving base image.
