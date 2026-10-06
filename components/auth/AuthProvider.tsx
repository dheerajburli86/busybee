// components/auth/AuthProvider.tsx
"use client";

import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import { useEffect, useState, ReactNode } from "react";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    let cancelled = false;
    supabase.auth
      .getSession()
      .then(({ data: { session } }) => {
        if (cancelled) return;
        setIsAuthenticated(!!session);
        if (!session) router.push("/login");
      })
      .finally(() => !cancelled && setIsLoading(false));

    // Follow sign-outs (and sign-ins in another tab).
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsAuthenticated(!!session);
      if (!session) router.push("/login");
    });

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, [supabase, router]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950">
        <div className="text-slate-400">Loading...</div>
      </div>
    );
  }

  return isAuthenticated ? (
    <>{children}</>
  ) : (
    <div className="flex items-center justify-center min-h-screen bg-slate-950">
      <div className="text-slate-400">Redirecting to login...</div>
    </div>
  );
}
