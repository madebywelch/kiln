// The files the agent hands a job: drive files, or files in its sandbox such as
// a Slack attachment. They ride on the job's Board task as attachments, and the
// worker downloads them into .kiln/inputs/ before the coding CLI starts.

import { posix } from "node:path";
import { MAX_JOB_FILE_BYTES, MAX_JOB_FILES } from "./jobs.ts";

export interface JobFile {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** Where a path is read from: the agent's sandbox (under /workspace/) or its drive (anything else). */
export interface FileSources {
  readonly sandbox: (path: string) => Promise<Uint8Array | null>;
  readonly drive: (path: string) => Promise<Uint8Array | null>;
}

const SANDBOX_ROOT = "/workspace/";

export class JobFileError extends Error {
  override readonly name = "JobFileError";
}

/**
 * Reads each path once and names the file by its basename, which is the name the worker sees in
 * .kiln/inputs/. Fails before anything is posted: too many files, a missing or empty one, one over
 * the size limit, a sandbox path outside /workspace/, or two files with the same name.
 */
export async function collectJobFiles(paths: readonly string[], sources: FileSources): Promise<JobFile[]> {
  if (paths.length > MAX_JOB_FILES) throw new JobFileError(`a job takes at most ${MAX_JOB_FILES} files`);
  const files: JobFile[] = [];
  const names = new Set<string>();
  for (const raw of paths) {
    const path = raw.trim();
    const inSandbox = path.startsWith("/");
    const clean = inSandbox ? posix.normalize(path) : path;
    if (inSandbox && !clean.startsWith(SANDBOX_ROOT)) {
      throw new JobFileError(`${path}: sandbox files must be under ${SANDBOX_ROOT}`);
    }
    const name = posix.basename(clean);
    if (!name) throw new JobFileError(`"${raw}" is not a file`);
    if (names.has(name)) throw new JobFileError(`two files are named ${name}; rename one in the drive first`);
    const bytes = await (inSandbox ? sources.sandbox(clean) : sources.drive(clean));
    if (!bytes) throw new JobFileError(`no file at ${path}`);
    if (bytes.byteLength === 0) throw new JobFileError(`${path} is empty`);
    if (bytes.byteLength > MAX_JOB_FILE_BYTES) {
      throw new JobFileError(`${path} is over ${MAX_JOB_FILE_BYTES / 1024 / 1024} MB`);
    }
    names.add(name);
    files.push({ name, bytes: new Uint8Array(bytes) });
  }
  return files;
}
