'use client';

import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const router = useRouter();
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
      });
      if (error) throw error;
      // Signed straight in (email confirmation off): the app shows "waiting
      // for access" until a supervisor adds them. Otherwise, confirm first.
      if (data.session) router.push('/dashboard');
      else setSent(true);
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950">
      <div className="bg-slate-800 p-8 rounded w-full max-w-md">
        <h1 className="text-2xl font-bold text-white mb-6">BusyBee Sign Up</h1>
        {error && <p className="text-red-500 mb-4">{error}</p>}
        {sent && (
          <p className="text-green-400 mb-4 text-sm">
            Account created. Check your email to confirm it, then log in. A supervisor will then add you to the team.
          </p>
        )}
        <form onSubmit={handleSignup} className="space-y-4">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-2 border border-slate-600 bg-slate-900 text-white rounded"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-2 border border-slate-600 bg-slate-900 text-white rounded"
          />
          <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">
            Sign Up
          </button>
        </form>
        <p className="text-slate-400 mt-4">
          Already have an account? <a href="/login" className="text-blue-500">Login</a>
        </p>
      </div>
    </div>
  );
}
