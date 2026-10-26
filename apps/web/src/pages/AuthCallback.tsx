import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { SSO_AUTO_DISABLED_KEY, SSO_SILENT_ATTEMPTED_KEY } from '../lib/auth';

/**
 * Handles redirects from Supabase auth emails (invite, recovery, magic link).
 *
 * The Supabase client auto-detects the access_token in the URL hash and
 * establishes a session. For invite/recovery flows we then prompt the user
 * to set a password before sending them to the app.
 */
export default function AuthCallback() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [flow, setFlow] = useState<'invite' | 'recovery' | 'signin' | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Parse type from hash *before* Supabase strips it.
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const type = params.get('type');
    const errDesc = params.get('error_description');
    if (errDesc) setError(errDesc.replace(/\+/g, ' '));

    if (type === 'invite' || type === 'signup') setFlow('invite');
    else if (type === 'recovery') setFlow('recovery');
    else setFlow('signin');

    if (!supabase) {
      setReady(true);
      return;
    }
    const sb = supabase;

    // Give the client a moment to process the hash.
    const t = setTimeout(async () => {
      const { data } = await sb.auth.getSession();
      if (!data.session) {
        // No session established (e.g. silent Microsoft sign-in found no
        // Office 365 session) — show the normal sign-in page.
        navigate('/signin', { replace: true });
        return;
      }
      sessionStorage.removeItem(SSO_SILENT_ATTEMPTED_KEY);
      sessionStorage.removeItem(SSO_AUTO_DISABLED_KEY);
      setReady(true);
    }, 250);
    return () => clearTimeout(t);
  }, [navigate]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (!supabase) {
      setError('Supabase not configured.');
      return;
    }
    setSaving(true);
    const { error: updErr } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (updErr) {
      setError(updErr.message);
      return;
    }
    navigate('/', { replace: true });
  };

  if (!ready) {
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <p className="text-sm text-slate-500">Finishing sign-in…</p>
      </div>
    );
  }

  if (flow === 'signin') {
    // Signed in via magic link — just go home.
    navigate('/', { replace: true });
    return null;
  }

  const heading = flow === 'recovery' ? 'Reset your password' : 'Set your password';
  const blurb =
    flow === 'recovery'
      ? 'Choose a new password for your account.'
      : 'Welcome! Choose a password to finish setting up your account.';

  return (
    <div className="mx-auto max-w-md p-8">
      <h1 className="page-title">{heading}</h1>
      <p className="mb-4 text-sm text-slate-600">{blurb}</p>
      <form onSubmit={submit} className="card-pad space-y-4">
        <div>
          <label htmlFor="cb-pw" className="field-label">New password</label>
          <input
            id="cb-pw"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </div>
        <div>
          <label htmlFor="cb-pw2" className="field-label">Confirm password</label>
          <input
            id="cb-pw2"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="field"
            autoComplete="new-password"
            minLength={8}
            required
          />
        </div>
        {error && <p className="text-sm text-rose-700">{error}</p>}
        <button type="submit" disabled={saving} className="btn-primary w-full">
          {saving ? 'Saving…' : 'Save and continue'}
        </button>
      </form>
    </div>
  );
}
