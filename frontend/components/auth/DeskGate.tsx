"use client";

// #21: someone who has signed up but hasn't been let onto the desk sees a
// clear "waiting for access" screen instead of empty pages and errors.

import { ReactNode, useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";

export function DeskGate({ children }: { children: ReactNode }) {
  const [waiting, setWaiting] = useState<{ email: string } | null>(null);
  // The layout (and this check) runs once per visit, not on every page, so
  // holding the page until it answers costs one short wait and spares people
  // who aren't on the desk yet a flash of empty pages and errors.
  const [checked, setChecked] = useState(false);
  // A network error or a non-OK response is not the same as "confirmed on
  // the desk" - failing open here (rendering children anyway) would defeat
  // the whole point of this gate under a transient outage. Track it
  // separately so we can show a retry screen instead of the app.
  const [checkFailed, setCheckFailed] = useState(false);

  const check = useCallback(async () => {
    setCheckFailed(false);
    try {
      const r = await fetch("/api/team/members", { cache: "no-store" });
      if (!r.ok) {
        setCheckFailed(true);
        return;
      }
      const d = await r.json();
      setWaiting(d.onDesk === false ? { email: d.email || "" } : null);
    } catch {
      setCheckFailed(true);
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  if (!checked) return <p className="text-slate-500 text-sm p-6">Loading...</p>;

  if (checkFailed) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center p-4">
        <div className="bg-slate-800 border border-slate-700 rounded p-6 max-w-md w-full text-center space-y-3">
          <p className="text-4xl">⚠️</p>
          <h1 className="text-xl font-bold">Couldn&apos;t check your access</h1>
          <p className="text-sm text-slate-300">We couldn&apos;t reach the server to confirm you&apos;re on the desk. Please try again.</p>
          <button onClick={check} className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm">Try again</button>
        </div>
      </div>
    );
  }

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
              try {
                await createClient().auth.signOut({ scope: "local" });
              } catch {
                /* the cookie is cleared locally either way */
              }
              window.location.href = "/login";
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
