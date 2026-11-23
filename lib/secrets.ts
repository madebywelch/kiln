// A repo's or project's secrets live in boat environments, one per group: how
// far its secrets reach. A job names the group it needs (`none` by default)
// and its machine starts in that group's environment, so it sees that group's
// secrets and no other group's or project's. Values go from a person, through
// code, into boat; they never pass through a model, a log, or the board.

import { type Boat, type Environment, type EnvironmentFlags, variableNames, variableValue } from "./boat.ts";

/** Secrets and nothing else: no GitHub login, no boat key, no agent logins on a job's machine. */
export const REPO_ENVIRONMENT_FLAGS: EnvironmentFlags = {
  safeForThirdParties: false,
  passGithub: false,
  passSecrets: true,
  passSandboxCredentials: false,
  passAgentsCredentials: false,
};

/** How far a group's secrets reach. A secret's name says what it is; its group says where. */
export const SECRET_GROUPS = ["staging", "production-read", "production-write"] as const;
export type SecretGroup = (typeof SECRET_GROUPS)[number];
/** What a job gets: no secrets, or one group's. */
export const JOB_SECRETS = ["none", ...SECRET_GROUPS] as const;
export type JobSecrets = (typeof JOB_SECRETS)[number];

/** What each group holds, for the agent's tools and the forms people save secrets in. */
export const GROUP_MEANING: Readonly<Record<SecretGroup, string>> = {
  staging:
    "staging and development: test databases, sandbox and staging API keys, keys that only spend money",
  "production-read":
    "production, read only: read-only database logins, read-only API keys, billing and analytics reads",
  "production-write":
    "production, able to change it: write database logins, deploy tokens, cluster credentials, admin API keys",
};

/** The environment of a job with no secrets: one for every project, holding nothing. */
export const NO_SECRETS_ENVIRONMENT = "kiln-none";

export function environmentName(repoKey: string, group: SecretGroup): string {
  return `kiln-${repoKey}-${group}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
}

/** The environment a job's machine starts in. */
export function jobEnvironmentName(repoKey: string, secrets: JobSecrets): string {
  return secrets === "none" ? NO_SECRETS_ENVIRONMENT : environmentName(repoKey, secrets);
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

/**
 * Each group's name prefix. A production secret's name says so, so the repo's own code, which reads
 * plain names such as DATABASE_URL, never picks one up by accident: a job passes it on purpose, to
 * the one step that needs it. Staging names are plain, for the code and its tests to read as they are.
 */
export const GROUP_PREFIX: Readonly<Record<SecretGroup, string>> = {
  staging: "",
  "production-read": "PROD_READ_",
  "production-write": "PROD_WRITE_",
};

/** Words that say where a secret reaches, which only a group's prefix may say. */
const WHERE_WORDS = new Set([
  "DEV",
  "DEVELOPMENT",
  "STAGE",
  "STAGING",
  "STG",
  "PROD",
  "PRODUCTION",
  "PRD",
  "READ",
  "READONLY",
  "RO",
  "WRITE",
  "RW",
]);

/** Why a name can't be a secret in this group, or null when it can. */
export function secretNameIssue(name: string, group: SecretGroup): string | null {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
    return "use capital letters, digits, and underscores, starting with a letter, like LINEAR_API_KEY";
  }
  if (RESERVED.has(name) || name.startsWith("KILN_") || name.startsWith("GIT_")) {
    return `${name} is reserved for kiln's workers`;
  }
  const prefix = GROUP_PREFIX[group];
  const named = SECRET_GROUPS.find((other) => GROUP_PREFIX[other] && name.startsWith(GROUP_PREFIX[other]));
  const what = named ? name.slice(GROUP_PREFIX[named].length) : name;
  // READ and WRITE say what a token does (GRAFANA_READ_TOKEN); only the environment words are refused there.
  const where = what
    .split("_")
    .filter((word) => WHERE_WORDS.has(word) && word !== "READ" && word !== "WRITE");
  if (named === group && what && where.length === 0) return null;
  if (!named && !prefix && where.length === 0) return null;
  const plain = what
    .split("_")
    .filter((word) => !where.includes(word))
    .join("_");
  const rule = prefix
    ? `a ${group} secret's name is ${prefix} and then what it is`
    : `a ${group} secret's name says only what it is`;
  return plain ? `${rule}, so ${prefix}${plain}` : rule;
}

export class SecretError extends Error {
  override readonly name = "SecretError";
}

const flagsDrift = (environment: Environment) =>
  (Object.keys(REPO_ENVIRONMENT_FLAGS) as (keyof EnvironmentFlags)[]).filter(
    (flag) => environment[flag] !== REPO_ENVIRONMENT_FLAGS[flag],
  );

type Log = (event: string, fields: Record<string, unknown>) => void;

/**
 * A job's environment, created on first use. A new boat environment passes everything, and someone
 * could switch a pass on in the dashboard later, so the flags are set on creation and put back whenever
 * they drift: a job's CLI runs without permission prompts and must not get the owner's logins.
 */
export async function jobEnvironment(
  boat: Boat,
  repoKey: string,
  secrets: JobSecrets,
  log: Log = () => undefined,
): Promise<Environment> {
  const name = jobEnvironmentName(repoKey, secrets);
  let environment = (await boat.environments()).find((candidate) => candidate.name === name);
  if (!environment) {
    environment = await boat.createEnvironment(name);
    log("secrets.environment_created", { repo: repoKey, secrets, environment: name });
  }
  const drift = flagsDrift(environment);
  if (drift.length > 0) {
    await boat.updateEnvironment(environment.id, REPO_ENVIRONMENT_FLAGS);
    log("secrets.environment_flags_reset", { repo: repoKey, environment: name, flags: drift });
    environment = { ...environment, ...REPO_ENVIRONMENT_FLAGS };
  }
  return environment;
}

/**
 * A secret's value, for copying it on to GitHub from the agent's own function. Never hand it to a
 * model, a sandbox, a log, or the board.
 */
export async function secretValue(
  boat: Boat,
  key: string,
  group: SecretGroup,
  name: string,
): Promise<string> {
  const environment = (await boat.environments()).find((e) => e.name === environmentName(key, group));
  const value = environment ? variableValue(environment.envContents, name) : undefined;
  if (!value) throw new SecretError(`${name} isn't in ${key}'s ${group} secrets`);
  return value;
}

export async function setSecret(
  boat: Boat,
  repoKey: string,
  group: SecretGroup,
  name: string,
  value: string,
): Promise<void> {
  const issue = secretNameIssue(name, group);
  if (issue) throw new SecretError(issue);
  if (value.length === 0) throw new SecretError("the value is empty");
  if (/[\r\n]/.test(value)) throw new SecretError("the value must be one line");
  const environment = await jobEnvironment(boat, repoKey, group);
  await boat.setVariable(environment.id, name, value);
}

/** Deletes a secret from a group. False when the group had no such secret. */
export async function deleteSecret(
  boat: Boat,
  repoKey: string,
  group: SecretGroup,
  name: string,
): Promise<boolean> {
  const environment = (await boat.environments()).find(
    (candidate) => candidate.name === environmentName(repoKey, group),
  );
  if (!environment || !variableNames(environment.envContents).includes(name)) return false;
  await boat.deleteVariable(environment.id, name);
  return true;
}

/** The names of a group's secrets, or of none for a job without secrets. Never the values. */
export async function secretNames(boat: Boat, repoKey: string, secrets: JobSecrets): Promise<string[]> {
  if (secrets === "none") return [];
  const name = environmentName(repoKey, secrets);
  const environment = (await boat.environments()).find((candidate) => candidate.name === name);
  return environment ? variableNames(environment.envContents) : [];
}

/** The names in every group of a repo or project, from one read of boat. */
export async function secretNamesByGroup(
  boat: Boat,
  repoKey: string,
): Promise<Record<SecretGroup, string[]>> {
  const environments = await boat.environments();
  const namesIn = (group: SecretGroup) => {
    const environment = environments.find((candidate) => candidate.name === environmentName(repoKey, group));
    return environment ? variableNames(environment.envContents) : [];
  };
  return {
    staging: namesIn("staging"),
    "production-read": namesIn("production-read"),
    "production-write": namesIn("production-write"),
  };
}
