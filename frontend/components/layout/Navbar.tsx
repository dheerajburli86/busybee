"use client";

import { createClient } from "@/lib/supabase";
import { useRouter } from "next/navigation";

export function Navbar() {
  const router = useRouter();
  const supabase = createClient();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  return (
    <nav className="bg-slate-800 border-b border-slate-700 p-4">
      <div className="max-w-7xl mx-auto flex justify-between items-center">
        <h1 className="text-white font-bold text-xl">BusyBee</h1>
        <button
          onClick={handleLogout}
          className="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded text-sm"
        >
          Logout
        </button>
      </div>
    </nav>
  );
}
