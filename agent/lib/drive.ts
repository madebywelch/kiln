// The agent's drive in production: files under kiln/drive/ in the same private
// Vercel Blob store as its memory (EVE_MEMORY_BLOB_STORE_ID), reached with the
// deployment's OIDC token. Under `eve dev` and in evals there is no store, and
// the drive lives in memory for the session.

import { BlobPreconditionFailedError, del, get, list, put } from "@vercel/blob";
import { DriveConflict, type DriveStore, ensureDefaults, memoryDrive } from "../../lib/drive.ts";

const ROOT = "kiln/drive/";

/**
 * A blob's version, for a conditional write: its strong ETag. A compressed read (a larger text file)
 * gets the weak form, W/"...", which `ifMatch` never matches.
 */
export function versionOf(etag: string): string {
  return etag.replace(/^W\//, "");
}

export function blobDrive(storeId: string): DriveStore {
  const options = { storeId };
  return {
    async list(prefix) {
      const entries = [];
      let cursor: string | undefined;
      do {
        const page = await list({
          prefix: `${ROOT}${prefix}`,
          limit: 1000,
          ...(cursor ? { cursor } : {}),
          ...options,
        });
        for (const blob of page.blobs) {
          entries.push({
            path: blob.pathname.slice(ROOT.length),
            size: blob.size,
            updatedAt: blob.uploadedAt.toISOString(),
          });
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return entries;
    },
    async read(path) {
      const result = await get(`${ROOT}${path}`, { access: "private", useCache: false, ...options });
      if (!result || result.statusCode !== 200) return null;
      return {
        bytes: new Uint8Array(await new Response(result.stream).arrayBuffer()),
        contentType: result.blob.contentType,
        version: versionOf(result.blob.etag),
      };
    },
    async write(path, bytes, contentType, ifVersion) {
      try {
        await put(`${ROOT}${path}`, Buffer.from(bytes), {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType,
          ...(ifVersion !== undefined ? { ifMatch: ifVersion } : {}),
          ...options,
        });
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError)
          throw new DriveConflict(`${path} changed since it was read`);
        throw error;
      }
    },
    async remove(path) {
      await del(`${ROOT}${path}`, options);
    },
  };
}

let local: DriveStore | undefined;
let defaults: Promise<void> | undefined;

/** The drive, with its default files in place. */
export async function drive(): Promise<DriveStore> {
  const storeId = process.env.EVE_MEMORY_BLOB_STORE_ID;
  if (!storeId) local ??= memoryDrive();
  const store = storeId ? blobDrive(storeId) : (local as DriveStore);
  defaults ??= ensureDefaults(store).catch((error: unknown) => {
    defaults = undefined; // try again next time
    throw error;
  });
  await defaults;
  return store;
}
