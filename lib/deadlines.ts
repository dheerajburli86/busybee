import { toLocalInput } from "@/components/tasks/types";

// One-tap deadlines for the create form (simple mode). Each lands at 6 PM,
// the end of a working day, so "tomorrow" means tomorrow evening.
export function quickDeadlines(): { label: string; value: string }[] {
  const at6 = (d: Date) => {
    const x = new Date(d);
    x.setHours(18, 0, 0, 0);
    return x;
  };
  const plus = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return at6(d);
  };
  const out: { label: string; value: string }[] = [];
  if (at6(new Date()).getTime() - Date.now() > 60 * 60 * 1000) out.push({ label: "Today", value: toLocalInput(at6(new Date()).toISOString()) });
  out.push({ label: "Tomorrow", value: toLocalInput(plus(1).toISOString()) });
  out.push({ label: "In 3 days", value: toLocalInput(plus(3).toISOString()) });
  const monday = new Date();
  monday.setDate(monday.getDate() + (((8 - monday.getDay()) % 7) || 7));
  out.push({ label: "Next Monday", value: toLocalInput(at6(monday).toISOString()) });
  out.push({ label: "In 2 weeks", value: toLocalInput(plus(14).toISOString()) });
  return out;
}
