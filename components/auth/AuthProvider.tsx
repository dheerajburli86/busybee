// components/auth/AuthProvider.tsx
"use client";

// Signed-out visitors never reach these pages (the middleware sends them to
// the login page first), so pages show straight away instead of waiting on a
// session check. This only watches, in the background, for the session
// ending - signed out in another tab, or expired - and goes to the login
// page then. The sign-in library loads after the page is up; it isn't needed
// to show the page.

import { useRouter } from "next/navigation";
import { useEffect, ReactNode } from "react";

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    const t = setTimeout(async () => {
      try {
        const { createClient } = await import("@/lib/supabase");
        if (cancelled) return;
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (cancelled) return;
        if (!session) {
          router.push("/login");
          return;
        }
        // Follow sign-outs (and sign-ins in another tab).
        const {
          data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, s) => {
          if (!s) router.push("/login");
        });
        stop = () => subscription.unsubscribe();
      } catch {
        /* offline: try again on the next visit */
      }
    }, 800);
    return () => {
      cancelled = true;
      clearTimeout(t);
      stop?.();
    };
  }, [router]);

  return <>{children}</>;
}
