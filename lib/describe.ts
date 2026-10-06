// Checklist #41: history shows "who changed what from X to Y". Changes store
// ids (a person, a project, a section...); this turns every id that appears
// in a set of history rows into a readable name.

import { inChunks } from "@/lib/chunks";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function collect(v: any, into: Set<string>) {
  if (typeof v === "string" && UUID.test(v)) into.add(v);
  else if (Array.isArray(v)) v.forEach((x) => collect(x, into));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collect(x, into));
}

/** Map of id -> name for every id mentioned in the rows' `changes`. */
export async function namesForChanges(supabase: any, rows: { changes?: any }[]): Promise<Record<string, string>> {
  const ids = new Set<string>();
  rows.forEach((r) => collect(r.changes, ids));
  const list = Array.from(ids);
  if (!list.length) return {};

  const lookups: [string, string, string][] = [
    ["users", "id, full_name, email", "person"],
    ["projects", "id, name", "project"],
    ["stages", "id, name", "section"],
    ["key_results", "id, title", "key result"],
    // Task titles are left out on purpose: whether someone may see a task is
    // decided by the app, not the database, so a title could leak here.
  ];
  const names: Record<string, string> = {};
  await Promise.all(
    lookups.map(async ([table, cols]) => {
      try {
        const rows = await inChunks<any>(list, (part) => supabase.from(table).select(cols).in("id", part));
        rows.forEach((r: any) => {
          names[r.id] = r.full_name || r.email || r.name || r.title || names[r.id];
        });
      } catch {
        /* a table this person can't read just stays as an id */
      }
    })
  );
  return names;
}
