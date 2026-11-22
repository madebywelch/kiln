// The agent's sandbox: eve's default image (Ubuntu, Node, Python 3, git, jq,
// curl) plus the tools for working on files people drop in Slack: ImageMagick
// for images and favicons, zip and unzip for archives, and file to tell what a
// file is. Installed once when eve builds the template, not on every session.

import { DefaultSandbox, defineSandbox } from "eve/sandbox";

const PACKAGES = ["imagemagick", "zip", "unzip", "file"];

export const environment = DefaultSandbox.environment({
  prepare: async (sandbox) => {
    const command = `sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${PACKAGES.join(" ")}`;
    const result = await sandbox.run({ command });
    if (result.exitCode !== 0) throw new Error(`Sandbox setup failed: ${result.stderr || result.stdout}`);
  },
});

export default defineSandbox(() => environment.open());
