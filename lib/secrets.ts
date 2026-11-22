// Each repo's secrets live in its own boat environment, `kiln-<repo>`. A job's
// machine starts in its repo's environment, so a job sees that repo's secrets
// and no other repo's. Values go from a person, through code, into boat; they
// never pass through a model, a log, or the board.

import { type Boat, type Environment, type EnvironmentFlags, variableNames } from "./boat.ts";

/** Secrets and nothing else: no GitHub login, no boat key, no agent logins on a job's machine. */
export const REPO_ENVIRONMENT_FLAGS: EnvironmentFlags = {
  safeForThirdParties: false,
  passGithub: false,
  passSecrets: true,
  passSandboxCredentials: false,
  passAgentsCredentials: false,
};

export function environmentName(repoKey: string): string {
  return `kiln-${repoKey}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
}

/**
 * Names a repo secret may not take: the worker's own settings, which a secret must not shadow, the
 * variables boat reserves, and the ones that change how programs run.
 */
const RESERVED = new Set([
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "BOARD_PROFILE",
  "BOARD_TOKEN",
  "BOARD_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HARNESS_GH_TOKEN",
  "HOME",
  "INFERENCE_API_KEY",
  "INFERENCE_BASE_URL",
  "JOB_TIMEOUT_MINUTES",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PATH",
  "SHELL",
  "USER",
  "VERCEL_ORG_ID",
  "VERCEL_TOKEN",
  "WORK_DIR",
  "WORKER_HARNESS",
  "ASCII_TOKEN",
  "ASCII_API_URL",
  "AGENT_ID",
  "PRODUCT_MODE",
  "ENVIRONMENT_ID",
  "BOAT_ID",
  "SERVICE_PREVIEW_TOKEN",
  "BOAT_CLI_TOKEN",
]);

/** Why a name can't be a repo secret, or null when it can. */
export function secretNameIssue(name: string): string | null {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
    return "use capital letters, digits, and underscores, starting with a letter, like LINEAR_API_KEY";
  }
  if (RESERVED.has(name) || name.startsWith("KILN_") || name.startsWith("GIT_")) {
    return `${name} is reserved for kiln's workers`;
  }
  return null;
}

export class SecretError extends Error {
  override readonly name = "SecretError";
}

const flagsDrift = (environment: Environment) =>
  (Object.keys(REPO_ENVIRONMENT_FLAGS) as (keyof EnvironmentFlags)[]).filter(
    (flag) => environment[flag] !== REPO_ENVIRONMENT_FLAGS[flag],
  );

/**
 * The repo's environment, created on first use. A new boat environment passes everything, and someone
 * could switch a pass on in the dashboard later, so the flags are set on creation and put back whenever
 * they drift: a job's CLI runs without permission prompts and must not get the owner's logins.
 */
export async function repoEnvironment(
  boat: Boat,
  repoKey: string,
  log: (event: string, fields: Record<string, unknown>) => void = () => undefined,
): Promise<Environment> {
  const name = environmentName(repoKey);
  let environment = (await boat.environments()).find((candidate) => candidate.name === name);
  if (!environment) {
    environment = await boat.createEnvironment(name);
    log("secrets.environment_created", { repo: repoKey, environment: name });
  }
  const drift = flagsDrift(environment);
  if (drift.length > 0) {
    await boat.updateEnvironment(environment.id, REPO_ENVIRONMENT_FLAGS);
    log("secrets.environment_flags_reset", { repo: repoKey, environment: name, flags: drift });
    environment = { ...environment, ...REPO_ENVIRONMENT_FLAGS };
  }
  return environment;
}

export async function setSecret(boat: Boat, repoKey: string, name: string, value: string): Promise<void> {
  const issue = secretNameIssue(name);
  if (issue) throw new SecretError(issue);
  if (value.length === 0) throw new SecretError("the value is empty");
  if (/[\r\n]/.test(value)) throw new SecretError("the value must be one line");
  const environment = await repoEnvironment(boat, repoKey);
  await boat.setVariable(environment.id, name, value);
}

/** The names of a repo's secrets. Never the values. */
export async function secretNames(boat: Boat, repoKey: string): Promise<string[]> {
  const name = environmentName(repoKey);
  const environment = (await boat.environments()).find((candidate) => candidate.name === name);
  return environment ? variableNames(environment.envContents) : [];
}
