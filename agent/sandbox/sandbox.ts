// The agent's sandbox: eve's default image (Ubuntu, Node, Python 3, git, jq,
// curl) plus the GitHub CLI and the tools for working on files people drop in
// Slack: ImageMagick for images and favicons, zip and unzip for archives, and
// file to tell what a file is. Installed once when eve builds the template.
// (eve's git image, with gh preinstalled, isn't published to Vercel Sandbox.)
//
// GitHub: on Vercel, the sandbox firewall adds the token to every request to
// api.github.com and github.com, so `gh` and `git` work as the token's owner
// while the token never enters the sandbox: the agent can't print it into Slack
// or a trace. `gh` only needs GH_TOKEN set to something to send requests; the
// firewall replaces what it sends. The token is KILN_GH_TOKEN, or the workers'
// WORKER_GH_TOKEN when that is unset. Locally (Docker) there is no firewall, so
// `gh` is unauthenticated there.

import { DefaultSandbox, defineSandbox, type SandboxNetworkPolicy } from "eve/sandbox";
import { agentGitHubToken } from "../../lib/config.ts";

const PACKAGES = ["gh", "imagemagick", "zip", "unzip", "file"];
/** What the sandbox's GH_TOKEN says; the firewall swaps in the real token. */
export const GH_TOKEN_PLACEHOLDER = "added-by-the-sandbox-firewall";

/** Allows all egress, and signs GitHub's API and git hosts with the token at the firewall. */
export function githubPolicy(token: string): SandboxNetworkPolicy {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    allow: {
      "api.github.com": [{ transform: [{ headers: { authorization: `Bearer ${token}` } }] }],
      "github.com": [{ transform: [{ headers: { authorization: `Basic ${basic}` } }] }],
      "*": [],
    },
  };
}

const token = agentGitHubToken();
if (!token && process.env.VERCEL) {
  console.warn(JSON.stringify({ event: "sandbox.github_token_missing", effect: "gh is unauthenticated" }));
}

export const environment = DefaultSandbox.environment({
  prepare: async (sandbox) => {
    const command = `sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${PACKAGES.join(" ")}`;
    const result = await sandbox.run({ command });
    if (result.exitCode !== 0) throw new Error(`Sandbox setup failed: ${result.stderr || result.stdout}`);
  },
  vercel: token ? { env: { GH_TOKEN: GH_TOKEN_PLACEHOLDER }, networkPolicy: githubPolicy(token) } : {},
});

export default defineSandbox(() => environment.open());
