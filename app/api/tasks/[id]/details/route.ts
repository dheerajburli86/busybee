// Everything the task panel shows, in one request: the phone makes one trip
// instead of ten, and the server works out the parts side by side. Each
// part is the same answer its own route gives (same rules, same checks).
import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient } from "@/lib/supabase-server";
import { requireUser } from "@/lib/permissions";
import { GET as access } from "../access/route";
import { GET as comments } from "../comments/route";
import { GET as attachments } from "../attachments/route";
import { GET as subtasks } from "../subtasks/route";
import { GET as activity } from "../activity/route";
import { GET as dependencies } from "../dependencies/route";
import { GET as extension } from "../extension/route";
import { GET as assignors } from "../assignors/route";
import { GET as accept } from "../accept/route";
import { GET as adjustment } from "../adjustment/route";
import { GET as siblings } from "../siblings/route";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const PARTS: Record<string, (req: any, ctx: Ctx) => Promise<Response>> = {
  access,
  comments,
  attachments,
  subtasks,
  activity,
  dependencies,
  extension,
  assignors,
  // The deadline / review / reward panels (TaskWorkflow).
  accept,
  adjustment,
  // Who else was given the same task at the same time.
  siblings,
};

export async function GET(request: NextRequest, ctx: Ctx) {
  const supabase = await createServerSideClient();
  if (!(await requireUser(supabase))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const entries = await Promise.all(
    Object.entries(PARTS).map(async ([name, handler]) => {
      try {
        const res = await handler(request, ctx);
        return [name, res.ok ? await res.json() : null] as const;
      } catch (err) {
        console.error(`task details: ${name} failed:`, err);
        return [name, null] as const;
      }
    })
  );
  const out = Object.fromEntries(entries);
  if (!out.access) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  return NextResponse.json(out);
}
