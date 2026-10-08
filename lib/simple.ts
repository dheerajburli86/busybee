// Simple mode: BusyBee shows only what the core flow needs - assign, accept
// the deadline, remind, finish, review, reward or penalise - and hides the
// extras (projects, sections, milestones, templates, dependencies, OKRs,
// chat, documents, timesheet, Gantt...). Nothing is deleted: the pages and
// data stay, they're just not shown.
//
// On by default. Set NEXT_PUBLIC_SIMPLE_MODE=off in Vercel and redeploy to
// bring every feature back.
export const SIMPLE = (process.env.NEXT_PUBLIC_SIMPLE_MODE || "").trim().toLowerCase() !== "off";
