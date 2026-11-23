// What kiln records about each secret beside its value in boat, which keeps
// names and values only: what the secret is, who saved it, when, and when it
// expires. One JSON file, keyed by boat environment, then by name. Never a
// value. boat stays the truth for which secrets exist: a label without a
// secret is ignored, and a secret without a label lists without one.

import { DriveConflict, type DriveStore } from "./drive.ts";
import type { GitHubCopy } from "./github-secrets.ts";

export interface SecretLabel {
  /** What it is and what it reaches, as the person who asked for it put it. */
  readonly description: string;
  /** The Slack user who saved it. */
  readonly savedBy: string;
  readonly savedAt: string;
  /** The day it stops working, YYYY-MM-DD, when it has one. */
  readonly expires?: string;
  /** Where it was copied in GitHub Actions; saving it again updates each copy. */
  readonly github?: readonly GitHubCopy[];
}

export type SecretLabels = Readonly<Record<string, Readonly<Record<string, SecretLabel>>>>;

export const SECRET_LABELS_FILE = "secret-labels.json";
const ATTEMPTS = 5;
/** How close to its expiry a secret is called out. */
export const EXPIRY_WARNING_DAYS = 14;

export async function readSecretLabels(store: DriveStore): Promise<SecretLabels> {
  const file = await store.read(SECRET_LABELS_FILE);
  if (!file) return {};
  try {
    return JSON.parse(new TextDecoder().decode(file.bytes)) as SecretLabels;
  } catch {
    return {}; // a broken file costs the descriptions, not the secrets
  }
}

/** Sets or, with null, removes a secret's label, retrying when someone else wrote the file meanwhile. */
export function labelSecret(
  store: DriveStore,
  environment: string,
  name: string,
  label: SecretLabel | null,
): Promise<void> {
  return updateSecretLabel(store, environment, name, () => label);
}

/** Rewrites a secret's label from what it is now (undefined when it has none); null removes it. */
export async function updateSecretLabel(
  store: DriveStore,
  environment: string,
  name: string,
  update: (label: SecretLabel | undefined) => SecretLabel | null,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const file = await store.read(SECRET_LABELS_FILE);
    let labels: Record<string, Record<string, SecretLabel>> = {};
    try {
      labels = file ? JSON.parse(new TextDecoder().decode(file.bytes)) : {};
    } catch {
      labels = {};
    }
    const group = { ...(labels[environment] ?? {}) };
    const label = update(group[name]);
    if (label) group[name] = label;
    else delete group[name];
    labels[environment] = group;
    const bytes = new TextEncoder().encode(`${JSON.stringify(labels, null, 2)}\n`);
    try {
      await store.write(SECRET_LABELS_FILE, bytes, "application/json", file?.version);
      return;
    } catch (error) {
      if (!(error instanceof DriveConflict) || attempt >= ATTEMPTS) throw error;
    }
  }
}

/** Whole days from `now` until a YYYY-MM-DD expiry; negative once it has passed. */
export function daysUntil(expires: string, now: number): number {
  return Math.floor((Date.parse(`${expires}T00:00:00Z`) - now) / 86_400_000);
}

/** Why an expiry date can't be used, or null when it can. */
export function expiryIssue(expires: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires) || Number.isNaN(Date.parse(`${expires}T00:00:00Z`)))
    return "expires is a date, YYYY-MM-DD";
  return null;
}
