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

In scope:

- Authentication or signature bypass on the HTTP API, SSE stream, artifact
  download, transcript download, or GitHub webhook.
- Path traversal, symlink escape, or cross-run access to artifacts, transcripts,
  worktrees, or the data directory.
- Publication of files, commits, ancestry, tags, or credentials outside the
  explicitly selected changeset.
- State corruption or privilege escalation caused by malformed workflow YAML,
  API input, or webhook payloads.
- Leakage of bearer tokens, provider keys, Git credentials, or Codex
  credentials through logs, artifacts, URLs, or error responses.

Out of scope:

- Code execution, prompt injection, or data exfiltration by an authorized
  workflow author or token holder.
- A malicious command escaping its process group, closing an inherited lease
  descriptor, or otherwise defeating cooperative cleanup.
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
