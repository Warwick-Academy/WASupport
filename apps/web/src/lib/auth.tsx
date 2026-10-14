import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Department, Profile, UserRole } from './types';

type ImpersonationTarget = {
  id: string;
  email: string;
  fullName: string | null;
  role: UserRole;
  department: Department | null;
};

type ActiveImpersonation = {
  auditId: string;
  targetId: string;
  targetEmail: string;
  targetRole: UserRole;
  targetDepartment: Department | null;
  reason: string;
  startedAt: string;
};

type StoredImpersonation = ActiveImpersonation & {
  adminSession: Session;
  restoreToken: string;
};

const IMPERSONATION_STORAGE_KEY = 'academydesk.admin-impersonation';

function storedImpersonation(): StoredImpersonation | null {
  try {
    const value = sessionStorage.getItem(IMPERSONATION_STORAGE_KEY);
    return value ? JSON.parse(value) as StoredImpersonation : null;
  } catch {
    return null;
  }
}

type AuthCtx = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  role: UserRole | null;
  isAdmin: boolean;
  isAvAdmin: boolean;
  isManager: boolean; // admin or manager
  isStaff: boolean;   // any non-submitter
  isTicketStaff: boolean;
  impersonation: ActiveImpersonation | null;
  loading: boolean;
  profileLoading: boolean;
  refreshProfile: () => Promise<void>;
  startImpersonation: (target: ImpersonationTarget, reason: string) => Promise<void>;
  stopImpersonation: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error?: string }>;
  signInWithMicrosoft: () => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

const STAFF_ROLES: UserRole[] = [
  'it_tech',
  'fac_tech',
  'hs_officer',
  'av_admin',
  'support',
  'manager',
  'admin',
  'leadership',
];

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [impersonation, setImpersonation] = useState<ActiveImpersonation | null>(() => {
    const stored = storedImpersonation();
    if (!stored) return null;
    const { adminSession: _adminSession, restoreToken: _restoreToken, ...active } = stored;
    return active;
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return;
    }
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabase || !session?.user) {
      setProfile(null);
      setProfileLoading(false);
      return;
    }
    let active = true;
    setProfileLoading(true);
    setProfile(null);
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, email, full_name, role, department, created_at')
          .eq('id', session.user.id)
          .maybeSingle();
        if (error) console.error('[AuthProvider] profile fetch failed', error);
        if (active) setProfile((data as Profile) ?? null);
      } catch (error) {
        console.error('[AuthProvider] profile fetch threw', error);
      } finally {
        if (active) setProfileLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [session?.user?.id]);

  const refreshProfile = async () => {
    if (!supabase || !session?.user) return;
    const { data } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, department, created_at')
      .eq('id', session.user.id)
      .maybeSingle();
    setProfile((data as Profile) ?? null);
  };

  const startImpersonation = async (target: ImpersonationTarget, reason: string) => {
    if (!supabase || !session || role !== 'admin') throw new Error('Admin session required');
    if (storedImpersonation()) throw new Error('An impersonation session is already active');
    const response = await fetch('/api/admin-impersonation', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ action: 'start', target_user_id: target.id, reason }),
    });
    const result = await response.json().catch(() => ({})) as {
      error?: string;
      audit_id?: string;
      restore_token?: string;
      token_hash?: string;
    };
    if (!response.ok || !result.audit_id || !result.restore_token || !result.token_hash) {
      throw new Error(result.error ?? `Could not start emulation (HTTP ${response.status})`);
    }

    const active: ActiveImpersonation = {
      auditId: result.audit_id,
      targetId: target.id,
      targetEmail: target.email,
      targetRole: target.role,
      targetDepartment: target.department,
      reason: reason.trim(),
      startedAt: new Date().toISOString(),
    };
    const stored: StoredImpersonation = {
      ...active,
      adminSession: session,
      restoreToken: result.restore_token,
    };
    sessionStorage.setItem(IMPERSONATION_STORAGE_KEY, JSON.stringify(stored));

    const { error } = await supabase.auth.verifyOtp({
      type: 'magiclink',
      token_hash: result.token_hash,
    });
    if (error) {
      sessionStorage.removeItem(IMPERSONATION_STORAGE_KEY);
      throw error;
    }
    setImpersonation(active);
  };

  const stopImpersonation = async () => {
    if (!supabase) throw new Error('Supabase not configured');
    const stored = storedImpersonation();
    if (!stored) throw new Error('No active emulation session');
    const { data } = await supabase.auth.getSession();
    const currentSession = data.session ?? stored.adminSession;

    const response = await fetch('/api/admin-impersonation', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${currentSession.access_token}`,
      },
      body: JSON.stringify({
        action: 'stop',
        audit_id: stored.auditId,
        restore_token: stored.restoreToken,
      }),
    });
    const result = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(result.error ?? `Could not stop emulation (HTTP ${response.status})`);

    await supabase.auth.signOut({ scope: 'local' });
    const { error } = await supabase.auth.setSession({
      access_token: stored.adminSession.access_token,
      refresh_token: stored.adminSession.refresh_token,
    });
    if (error) throw error;
    sessionStorage.removeItem(IMPERSONATION_STORAGE_KEY);
    setImpersonation(null);
  };

  const role = profile?.role ?? null;
  const isAdmin = role === 'admin';
  const isAvAdmin = role === 'av_admin';
  const isManager = role === 'admin' || role === 'manager';
  const isStaff = role !== null && STAFF_ROLES.includes(role);
  const isTicketStaff = isStaff && role !== 'av_admin';

  const value: AuthCtx = {
    session,
    user: session?.user ?? null,
    profile,
    role,
    isAdmin,
    isAvAdmin,
    isManager,
    isStaff,
    isTicketStaff,
    impersonation,
    loading,
    profileLoading,
    refreshProfile,
    startImpersonation,
    stopImpersonation,
    signIn: async (email, password) => {
      if (!supabase) return { error: 'Supabase not configured' };
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return error ? { error: error.message } : {};
    },
    signUp: async (email, password, fullName) => {
      if (!supabase) return { error: 'Supabase not configured' };
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName } },
      });
      return error ? { error: error.message } : {};
    },
    signInWithMicrosoft: async () => {
      if (!supabase) return { error: 'Supabase not configured' };
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'azure',
        options: {
          scopes: 'openid email profile offline_access Calendars.ReadWrite',
          redirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      return error ? { error: error.message } : {};
    },
    signOut: async () => {
      if (!supabase) return;
      if (storedImpersonation()) await stopImpersonation();
      await supabase.auth.signOut();
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
