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
    const checkAuth = async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        setIsAuthenticated(!!session);

        if (!session) {
          router.push("/login");
        }

        // Listen for auth changes
        const {
          data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
          setIsAuthenticated(!!session);
          if (!session) {
            router.push("/login");
          }
        });

        return () => subscription?.unsubscribe();
      } finally {
        setIsLoading(false);
      }
    };

    checkAuth();
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
