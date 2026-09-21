"use client";

// #21: someone who has signed up but hasn't been let onto the desk sees a
// clear "waiting for access" screen instead of empty pages and errors.

import { ReactNode, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase";

export function DeskGate({ children }: { children: ReactNode }) {
  const [waiting, setWaiting] = useState<{ email: string } | null>(null);
  const router = useRouter();

  const check = useCallback(async () => {
    try {
      const r = await fetch("/api/team/members", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      setWaiting(d.onDesk === false ? { email: d.email || "" } : null);
    } catch {
      /* leave the page as it is */
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  if (!waiting) return <>{children}</>;

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-4">
      <div className="bg-slate-800 border border-slate-700 rounded p-6 max-w-md w-full text-center space-y-3">
        <p className="text-4xl">🐝</p>
        <h1 className="text-xl font-bold">Waiting for access</h1>
        <p className="text-sm text-slate-300">
          You&apos;re signed in{waiting.email ? ` as ${waiting.email}` : ""}, but a supervisor still needs to add you to the team.
          They&apos;ll see your name under <b>Teams → Waiting for access</b>.
        </p>
        <div className="flex justify-center gap-2 pt-2">
          <button onClick={check} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm">Check again</button>
          <button
            onClick={async () => {
              await createClient().auth.signOut();
              router.push("/login");
            }}
            className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm"
          >
            Log out
          </button>
        </div>
      </div>
    </div>
  );
}
