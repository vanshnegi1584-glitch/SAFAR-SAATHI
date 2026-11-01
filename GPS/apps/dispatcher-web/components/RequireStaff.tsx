'use client';

import type { Me } from '@transitlink/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { DEV_TOKEN, getAuth, getTracking } from '@/lib/live';

/** Sign-in gate for dispatcher/admin pages. The role is checked again by the server on every call. */
export function RequireStaff({ admin = false, children }: { admin?: boolean; children: (me: Me) => ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const load = async () => {
    const who = await getTracking().me();
    const ok = admin ? who.role === 'admin' : who.role === 'admin' || who.role === 'operator';
    if (!ok) {
      setError(`Your account role is "${who.role}". This page needs ${admin ? 'an admin' : 'a dispatcher or admin'} account.`);
      return;
    }
    setMe(who);
  };

  useEffect(() => {
    void (async () => {
      try {
        if (DEV_TOKEN || (await getAuth().restore())) await load();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  if (me) return <>{children(me)}</>;
  if (checking) return <div className="grid h-full place-items-center text-sm text-slate-500">Checking session…</div>;

  return (
    <div className="grid h-full place-items-center bg-slate-50 p-4">
      <form
        className="w-full max-w-sm space-y-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await getAuth().signIn(email.trim(), password);
            await load();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="text-sm text-slate-500">Dispatcher or admin account required.</p>
        <input className="w-full rounded border border-slate-300 px-3 py-2" type="email" placeholder="Email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="w-full rounded border border-slate-300 px-3 py-2" type="password" placeholder="Password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button className="w-full rounded bg-slate-900 py-2 font-medium text-white disabled:opacity-50" disabled={!email || !password}>Sign in</button>
      </form>
    </div>
  );
}
