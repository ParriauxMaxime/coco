import { z } from "zod";
import type { DevServersConfig } from "./config.ts";

export type StackRow = { key: string | number; branch: string | null };
export type StackOrder = (branch: string) => Promise<StackRow[] | null>;

const stackReplySchema = z.object({
  work: z.object({ slug: z.string(), title: z.string().optional() }).nullable(),
  rows: z.array(z.object({ key: z.union([z.string(), z.number()]), branch: z.string().nullable() })),
});

// The rows of the coco work that has this branch, in merge order; [] when no work has it, null when coco does not answer.
export function cocoStackOrder({ url, timeoutMs }: DevServersConfig["coco"]): StackOrder | undefined {
  if (!url) return undefined;
  return async (branch) => {
    try {
      const response = await fetch(new URL(`/api/paseo-link/stack?branch=${encodeURIComponent(branch)}`, url), { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return null;
      const reply = stackReplySchema.safeParse(await response.json());
      if (!reply.success) return null;
      return reply.data.work ? reply.data.rows : [];
    } catch {
      return null;
    }
  };
}
