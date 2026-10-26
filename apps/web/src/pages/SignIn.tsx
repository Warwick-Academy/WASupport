import { useEffect, useRef, useState } from 'react';
import { useNavigate, Navigate, useSearchParams } from 'react-router-dom';
import { SSO_AUTO_DISABLED_KEY, SSO_SILENT_ATTEMPTED_KEY, useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

function shouldAutoSso(manual: boolean) {
  if (!supabase || manual) return false;
  return (
    !sessionStorage.getItem(SSO_SILENT_ATTEMPTED_KEY) &&
    !sessionStorage.getItem(SSO_AUTO_DISABLED_KEY)
  );
}

export default function SignIn() {
  const { user, signIn, signUp, signInWithMicrosoft, loading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [autoSso, setAutoSso] = useState(() => shouldAutoSso(searchParams.has('manual')));
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [ssoBusy, setSsoBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const ssoStarted = useRef(false);

  useEffect(() => {
    if (loading || user || !autoSso || ssoStarted.current) return;
    ssoStarted.current = true;
    signInWithMicrosoft({ silent: true }).then((res) => {
      if (res.error) setAutoSso(false);
    });
  }, [loading, user, autoSso, signInWithMicrosoft]);

  if (loading) return null;
  if (user) return <Navigate to="/" replace />;
  if (autoSso) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center p-6 text-center">
        <h1 className="text-2xl font-bold text-brand-navy">WA Support Center</h1>
        <p className="mt-3 text-sm text-slate-500">Checking your Microsoft 365 sign-in…</p>
        <button
          type="button"
          onClick={() => {
            sessionStorage.setItem(SSO_AUTO_DISABLED_KEY, '1');
            setAutoSso(false);
          }}
          className="mt-4 text-xs text-slate-400 underline hover:text-slate-600"
        >
          Use a password instead
        </button>
      </main>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const res =
      mode === 'in' ? await signIn(email, password) : await signUp(email, password, fullName);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    if (mode === 'up') {
      setInfo('Account created. Check your email if confirmation is enabled, then sign in.');
      setMode('in');
    } else {
      navigate('/');
    }
  }

  async function microsoftSignIn() {
    setError(null);
    setInfo(null);
    setSsoBusy(true);
    const res = await signInWithMicrosoft();
    if (res.error) {
      setSsoBusy(false);
      setError(res.error);
    }
    // On success the browser is redirected to Microsoft, so no further state
    // updates are needed here.
  }

  const tabClass = (active: boolean) =>
    [
      'flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold transition-all duration-200',
      active
        ? 'bg-brand-navy text-white shadow-sm'
        : 'bg-slate-100 text-slate-600 hover:bg-slate-200',
    ].join(' ');

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold text-brand-navy" style={{ letterSpacing: '0.5px' }}>
          WA Support Center
        </h1>
        <p className="mt-1 text-sm italic text-slate-500">
          Warwick Academy helpdesk &amp; AI assistant
        </p>
      </div>

      <div className="card-pad">
        <button
          type="button"
          onClick={microsoftSignIn}
          disabled={ssoBusy || busy}
          className="mb-5 flex w-full items-center justify-center gap-3 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <svg aria-hidden="true" viewBox="0 0 23 23" className="h-4 w-4">
            <rect x="1"  y="1"  width="10" height="10" fill="#F25022" />
            <rect x="12" y="1"  width="10" height="10" fill="#7FBA00" />
            <rect x="1"  y="12" width="10" height="10" fill="#00A4EF" />
            <rect x="12" y="12" width="10" height="10" fill="#FFB900" />
          </svg>
          {ssoBusy ? 'Redirecting…' : 'Sign in with Microsoft'}
        </button>

        <div className="mb-5 flex items-center gap-3 text-xs uppercase tracking-wider text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />
          or use a password
          <span className="h-px flex-1 bg-slate-200" />
        </div>

        <div className="mb-6 flex gap-2">
          <button type="button" onClick={() => setMode('in')} className={tabClass(mode === 'in')}>
            Sign in
          </button>
          <button type="button" onClick={() => setMode('up')} className={tabClass(mode === 'up')}>
            Create account
          </button>
        </div>

        <form onSubmit={submit} className="space-y-5">
          {mode === 'up' && (
            <div>
              <label htmlFor="full-name" className="field-label">
                Full name
              </label>
              <input
                id="full-name"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="field"
              />
            </div>
          )}
          <div>
            <label htmlFor="email" className="field-label">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="field"
            />
          </div>
          <div>
            <label htmlFor="password" className="field-label">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field"
            />
          </div>

          {error && <p className="alert-error">{error}</p>}
          {info && <p className="alert-success">{info}</p>}

          <button disabled={busy} className="btn-primary w-full">
            {busy ? 'Please wait…' : mode === 'in' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </div>
    </main>
  );
}
