// Two limits to stay inside when reading lists from Supabase:
//   - `.in("id", [...])` filters travel in the URL, and very long URLs are
//     rejected, so long id lists are sent in batches (inChunks);
//   - a single request returns at most 1000 rows (Supabase's default "max
//     rows"), so lists that can grow past that are read page by page
//     (selectAll).

export const CHUNK = 100;
const PAGE = 1000;

export function chunk<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Every row of a query, reading 1000 at a time. `build` must return a fresh query each call. */
export async function selectAll<R>(build: () => any): Promise<R[]> {
  const rows: R[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...((data || []) as R[]));
    if (!data || data.length < PAGE) return rows;
  }
}

/** At most `max` rows of a query (newest first, say), still 1000 per request. */
export async function selectUpTo<R>(build: () => any, max: number): Promise<R[]> {
  const rows: R[] = [];
  for (let from = 0; from < max; from += PAGE) {
    const to = Math.min(from + PAGE, max) - 1;
    const { data, error } = await build().range(from, to);
    if (error) throw error;
    rows.push(...((data || []) as R[]));
    if (!data || data.length < to - from + 1) break;
  }
  return rows;
}

/**
 * Run a query once per batch of ids and concatenate the rows. With
 * `{ all: true }` each batch is also read page by page.
 */
export async function inChunks<R>(ids: string[], build: (part: string[]) => any, opts: { all?: boolean } = {}): Promise<R[]> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return [];
  const parts = await Promise.all(
    chunk(unique).map(async (part) => {
      if (opts.all) return selectAll<R>(() => build(part));
      const { data, error } = await build(part);
      if (error) throw error;
      return (data || []) as R[];
    })
  );
  return parts.flat();
}
