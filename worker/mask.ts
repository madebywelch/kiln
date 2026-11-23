// Hides the values of a job's secrets in everything that leaves its machine or
// outlives its run: the board replies, the pull request description, returned
// files, the worker's log, and the coding CLI's own logs and session. A CLI
// that prints a secret, as one did a database URL while reporting a parse
// error, leaves `[NAME hidden]` in its place, and the job update says so.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Shorter values are too likely to occur by chance; hiding them would garble output without protecting much. */
const MIN_SECRET_CHARS = 8;
/** A run of token-like characters this long inside a value is treated as a secret of its own. */
const TOKEN_RUN = /[A-Za-z0-9+/=_-]{24,}/g;

export interface Mask {
  /** The text with every secret form replaced by `[NAME hidden]`. */
  (text: string): string;
  /** The secrets this mask has hidden so far, by name. */
  readonly hidden: ReadonlySet<string>;
  /** The secrets whose values occur in the text, without hiding anything. */
  find(text: string): string[];
}

/** The forms a secret's value takes in output: itself, encoded, decoded, and the credentials inside it. */
export function secretForms(value: string): string[] {
  const forms = new Set<string>();
  const add = (form: string | undefined) => {
    if (form && form.length >= MIN_SECRET_CHARS) forms.add(form);
  };
  const addWithRuns = (text: string) => {
    add(text);
    for (const run of text.match(TOKEN_RUN) ?? []) add(run);
  };
  addWithRuns(value);
  add(encodeURIComponent(value));
  const base64 = Buffer.from(value).toString("base64");
  add(base64);
  add(base64.replace(/=+$/, ""));
  add(Buffer.from(value).toString("base64url"));
  try {
    const url = new URL(value);
    if (url.password) {
      add(url.password);
      add(decodeURIComponent(url.password));
    }
  } catch {
    // not a URL
  }
  if (/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    try {
      // A base64 value, such as a kubeconfig, holds tokens a CLI can print on their own.
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64"));
      if (/^[\t\n\r\x20-\x7e]+$/.test(decoded)) addWithRuns(decoded);
    } catch {
      // not text
    }
  }
  return [...forms];
}

/** A mask for the named secrets in `env`. Unset and short ones are skipped. */
export function secretMask(env: NodeJS.ProcessEnv, names: readonly string[]): Mask {
  const forms: { readonly form: string; readonly name: string }[] = [];
  for (const name of names) {
    const value = env[name];
    if (value) for (const form of secretForms(value)) forms.push({ form, name });
  }
  // Longest first, so a whole value is hidden before a part of it can be.
  forms.sort((a, b) => b.form.length - a.form.length);
  const hidden = new Set<string>();
  const mask = ((text: string) => {
    let out = text;
    for (const { form, name } of forms) {
      if (!out.includes(form)) continue;
      out = out.split(form).join(`[${name} hidden]`);
      hidden.add(name);
    }
    return out;
  }) as Mask;
  Object.defineProperty(mask, "hidden", { value: hidden });
  mask.find = (text) =>
    [...new Set(forms.filter(({ form }) => text.includes(form)).map(({ name }) => name))].sort();
  return mask;
}

/** A mask that hides nothing, for a job with no secrets. */
export const noMask: Mask = secretMask({}, []);

/**
 * Rewrites each text file under these paths (files or folders, recursively) with its secrets hidden.
 * Binary files, such as a CLI's database, are left alone: rewriting one as text would break it.
 */
export async function maskFiles(mask: Mask, paths: readonly string[]): Promise<void> {
  if (mask.find === noMask.find) return;
  for (const path of paths) {
    let files: string[];
    try {
      const entries = await readdir(path, { withFileTypes: true, recursive: true });
      files = entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
    } catch {
      files = [path];
    }
    for (const file of files) {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = new Uint8Array(await readFile(file));
      } catch {
        continue; // gone, or not readable
      }
      const masked = maskBytes(mask, bytes);
      if (masked !== bytes) await writeFile(file, masked);
    }
  }
}

/** A file's bytes with its secrets hidden, when it is UTF-8 text; other files as they are. */
export function maskBytes(mask: Mask, bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return bytes;
  }
  const masked = mask(text);
  return masked === text ? bytes : new Uint8Array(Buffer.from(masked));
}
