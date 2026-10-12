'use client';

import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { isStandalone } from '@/lib/pushClient';
import { forgetAll, prefetch } from '@/lib/apiCache';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const signingIn = useRef(false);
  // Inside the installed app the "get the app" link has nothing to offer.
  const [inApp, setInApp] = useState(false);
  useEffect(() => setInApp(isStandalone()), []);
  const router = useRouter();
  const supabase = createClient();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (signingIn.current) return;
    signingIn.current = true;
    setError('');
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) throw error;
      // A fresh start for whoever signed in: nobody else's remembered data,
      // and their tasks already on the way while the next page opens.
      forgetAll();
      prefetch(['/api/tasks', '/api/team/members', '/api/projects', '/api/notifications']);
      const next = new URLSearchParams(window.location.search).get('next');
      // Only ever go back to a page of this site ("//x" and "/\x" are other sites).
      router.push(next && /^\/(?![\/\\])/.test(next) ? next : '/dashboard');
    } catch (err: any) {
      setError(err.message);
      signingIn.current = false;
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 px-4 safe-top safe-bottom">
      <div className="bg-slate-800 p-6 sm:p-8 rounded-xl w-full max-w-md">
        <h1 className="text-2xl font-bold text-white mb-6">BusyBee Login</h1>
        {error && <p className="text-red-500 mb-4">{error}</p>}
        <form onSubmit={handleLogin} className="space-y-4">
          <input
            type="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-2 border border-slate-600 bg-slate-900 text-white rounded"
          />
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-2 border border-slate-600 bg-slate-900 text-white rounded"
          />
          <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">
            Login
          </button>
        </form>
        <p className="text-slate-400 mt-4">
          Don't have an account? <a href="/signup" className="text-blue-500">Sign up</a>
        </p>
      </div>
      {!inApp && (
        <a href="/install" className="mt-6 text-sm text-amber-300 hover:text-amber-200">
          📱 Get BusyBee on your phone as an app
        </a>
      )}
    </div>
  );
}
