// The scheduled tasks still to come. eve's generated schedule__tasks__list
// keeps every one-time task that already fired, as "active", sorted by name, so
// a pending one hides among hundreds. This lists only what is still to come,
// soonest first, and deletes the spent one-time tasks it finds, which would
// never fire again.

import { schedules } from "eve/experimental/schedules";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { isSpent, pendingTasks, type TaskRecord } from "../lib/scheduled-task.ts";
import tasks from "../schedules/tasks.ts";

/** Pages read per call: 100 tasks each. */
const MAX_PAGES = 20;
const DELETE_CONCURRENCY = 10;

export default defineTool({
  description:
    "List your scheduled tasks that are still to come: name, label, when they run (one-time ones soonest first, then recurring), and whether disabled. Use it instead of schedule__tasks__list to find a task to change or cancel; pass `query` to match a name or label. One-time tasks that already ran are deleted as it lists, since they never run again.",
  inputSchema: z.object({
    query: z.string().optional().describe("Only tasks whose name or label contains this."),
  }),
  label: { start: () => "Check scheduled tasks" },
  async execute({ query }) {
    const client = await schedules(tasks);
    const records: TaskRecord[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const listed = await client.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      records.push(...(listed.data as readonly TaskRecord[]));
      cursor = listed.cursor;
      if (!cursor) break;
    }
    const now = Date.now();
    const spent = records.filter((record) => isSpent(record, now)).map((record) => record.name);
    let removed = 0;
    for (let i = 0; i < spent.length; i += DELETE_CONCURRENCY) {
      const results = await Promise.allSettled(
        spent.slice(i, i + DELETE_CONCURRENCY).map((name) => client.delete(name)),
      );
      removed += results.filter((result) => result.status === "fulfilled").length;
    }
    if (spent.length > 0)
      console.info(JSON.stringify({ event: "tasks.spent_removed", removed, of: spent.length }));
    return {
      pending: pendingTasks(records, now, query),
      ...(removed > 0 ? { removedSpent: removed } : {}),
      ...(cursor
        ? { note: `more than ${MAX_PAGES * 100} tasks; only the first ${MAX_PAGES * 100} were read` }
        : {}),
    };
  },
});
