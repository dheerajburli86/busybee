"use client";

// Where the "Set your password" link from the welcome email lands (also used
// for "forgot password"). The link signs the person in; here they choose a
// password and go straight into BusyBee.
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase";

export default function WelcomePage() {
  const [ready, setReady] = useState<"checking" | "ok" | "bad">("checking");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const access_token = hash.get("access_token");
    const refresh_token = hash.get("refresh_token");
    (async () => {
      if (access_token && refresh_token) {
        const { error } = await supabase.auth.setSession({ access_token, refresh_token });
        window.history.replaceState(null, "", "/welcome");
        setReady(error ? "bad" : "ok");
        return;
      }
      const { data } = await supabase.auth.getUser();
      setReady(data.user ? "ok" : "bad");
    })();
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (pw.length < 8) return setError("At least 8 characters.");
    if (pw !== pw2) return setError("The two passwords don't match.");
    setSaving(true);
    const { error } = await createClient().auth.updateUser({ password: pw });
    setSaving(false);
    if (error) return setError(error.message);
    window.location.assign("/dashboard");
  };

  const box = "w-full px-4 py-2 border border-slate-600 bg-slate-900 text-white rounded";
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-slate-800 border border-slate-700 rounded p-6">
        <h1 className="text-2xl font-bold mb-2">🐝 Welcome to BusyBee</h1>
        {ready === "checking" && <p className="text-slate-400">One moment...</p>}
        {ready === "bad" && (
          <p className="text-slate-300">
            This link has expired or was already used. Ask whoever added you to add you again, or{" "}
            <a href="/login" className="text-blue-400 underline">sign in</a>.
          </p>
        )}
        {ready === "ok" && (
          <form onSubmit={save} className="space-y-3">
            <p className="text-sm text-slate-300">Choose a password to finish setting up.</p>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password" className={box} autoComplete="new-password" />
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="Same password again" className={box} autoComplete="new-password" />
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button type="submit" disabled={saving} className="bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white px-5 py-2 rounded font-semibold">
              {saving ? "Saving..." : "Save and open BusyBee"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
