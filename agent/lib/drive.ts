// The agent's drive in production: files under kiln/drive/ in the same private
// Vercel Blob store as its memory (EVE_MEMORY_BLOB_STORE_ID), reached with the
// deployment's OIDC token. Under `eve dev` and in evals there is no store, and
// the drive lives in memory for the session.

import { del, get, list, put } from "@vercel/blob";
import { type DriveStore, ensureReadme, memoryDrive } from "../../lib/drive.ts";

const ROOT = "kiln/drive/";

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
      };
    },
    async write(path, bytes, contentType) {
      await put(`${ROOT}${path}`, Buffer.from(bytes), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType,
        ...options,
      });
    },
    async remove(path) {
      await del(`${ROOT}${path}`, options);
    },
  };
}

let local: DriveStore | undefined;
let readme: Promise<void> | undefined;

/** The drive, with its README in place. */
export async function drive(): Promise<DriveStore> {
  const storeId = process.env.EVE_MEMORY_BLOB_STORE_ID;
  if (!storeId) local ??= memoryDrive();
  const store = storeId ? blobDrive(storeId) : (local as DriveStore);
  readme ??= ensureReadme(store).catch((error: unknown) => {
    readme = undefined; // try again next time
    throw error;
  });
  await readme;
  return store;
}
