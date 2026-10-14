import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import {
  DEPARTMENT_LABEL,
  ROLE_DEPARTMENT,
  ROLE_LABEL,
  type Department,
  type Profile,
  type UserRole,
} from '../lib/types';

const DEPARTMENTS = Object.keys(DEPARTMENT_LABEL) as Department[];

const ASSIGNABLE_ROLES: UserRole[] = [
  'submitter',
  'support',
  'it_tech',
  'fac_tech',
  'hs_officer',
  'av_admin',
  'manager',
  'leadership',
  'admin',
];

export default function AdminUsers() {
  const { isAdmin, role, startImpersonation } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('submitter');
  const [newDept, setNewDept] = useState<Department | ''>('');
  const [view, setView] = useState<'staff' | 'submitters'>('staff');
  const [createMsg, setCreateMsg] = useState<string | null>(null);
  const [emulatingUser, setEmulatingUser] = useState<Profile | null>(null);
  const [emulationReason, setEmulationReason] = useState('');
  const [emulationError, setEmulationError] = useState<string | null>(null);
  const [isStartingEmulation, setIsStartingEmulation] = useState(false);

  async function beginEmulation(event: React.FormEvent) {
    event.preventDefault();
    if (!emulatingUser) return;
    setEmulationError(null);
    setIsStartingEmulation(true);
    try {
      await startImpersonation({
        id: emulatingUser.id,
        email: emulatingUser.email,
        fullName: emulatingUser.full_name,
        role: emulatingUser.role,
        department: emulatingUser.department,
      }, emulationReason);
      navigate('/', { replace: true });
    } catch (error) {
      setEmulationError(error instanceof Error ? error.message : 'Could not start emulation.');
    } finally {
      setIsStartingEmulation(false);
    }
  }

  const { data, isLoading } = useQuery({
    queryKey: ['admin-users', search],
    enabled: isAdmin,
    queryFn: async (): Promise<Profile[]> => {
      if (!supabase) throw new Error('Supabase not configured');
      let q = supabase
        .from('profiles')
        .select('id, email, full_name, role, department, created_at')
        .order('created_at', { ascending: false })
        .limit(200);
      if (search.trim()) {
        const s = search.trim().replace(/[%_]/g, '');
        q = q.or(`email.ilike.%${s}%,full_name.ilike.%${s}%`);
      }
      const { data, error } = await q;
      if (error) throw error;
      return data as Profile[];
    },
  });

  const updateProfile = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: { role?: UserRole; department?: Department | null };
    }) => {
      if (!supabase) throw new Error('Supabase not configured');
      const { error } = await supabase.from('profiles').update(patch).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-users'] }),
    onError: (e: Error) => setError(e.message),
  });

  const { staff, submitters } = useMemo(() => {
    const all = data ?? [];
    const deptOrder = (u: Profile) => (u.department ? DEPARTMENTS.indexOf(u.department) : 99);
    return {
      staff: all
        .filter((u) => u.role !== 'submitter')
        .sort(
          (a, b) =>
            deptOrder(a) - deptOrder(b) ||
            Number(b.role === 'manager') - Number(a.role === 'manager') ||
            (a.full_name ?? a.email).localeCompare(b.full_name ?? b.email),
        ),
      submitters: all.filter((u) => u.role === 'submitter'),
    };
  }, [data]);
  const rows = view === 'staff' ? staff : submitters;

  const createUser = useMutation({
    mutationFn: async () => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error('No active session');
      const res = await fetch('/api/admin-create-user', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          email: newEmail.trim(),
          full_name: newName.trim() || undefined,
          role: newRole,
          department: newRole === 'manager' && newDept ? newDept : undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
        existing?: boolean;
      };
      if (!res.ok) {
        let detail = body.detail;
        if (detail) {
          try {
            const parsed = JSON.parse(detail) as {
              message?: string;
              msg?: string;
              error_description?: string;
              error?: string;
            };
            detail = parsed.message ?? parsed.msg ?? parsed.error_description ?? parsed.error ?? detail;
          } catch {
            // Keep the raw upstream response when it is not JSON.
          }
        }
        throw new Error([body.error ?? `HTTP ${res.status}`, detail].filter(Boolean).join(': '));
      }
      return { existing: body.existing ?? false };
    },
    onSuccess: ({ existing }) => {
      setCreateMsg(existing
        ? `Existing account ${newEmail.trim()} added to user management with the selected role.`
        : `Invitation sent to ${newEmail.trim()}.`);
      setNewEmail('');
      setNewName('');
      setNewRole('submitter');
      setNewDept('');
      setShowAdd(false);
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!isAdmin) {
    return <p className="alert-warn">Admins only. Your role: {role ?? 'unknown'}.</p>;
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <h1 className="page-title">User management</h1>
          <p className="text-sm italic text-slate-500">
            Department staff belong to IT Support, Facilities or Audio Visual. Technician roles set
            the department automatically; a <strong>Department Manager</strong> receives new tickets
            that can&apos;t be routed to a category owner. Category owners are set on the{' '}
            <Link to="/admin/categories" className="underline">Categories</Link> page.
          </p>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search name or email…"
          className="field-sm w-72"
        />
      </div>

      <div className="mb-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            setShowAdd((s) => !s);
            setError(null);
            setCreateMsg(null);
          }}
          className="btn-primary"
        >
          {showAdd ? 'Cancel' : '+ Add user'}
        </button>
        {createMsg && <p className="text-sm text-emerald-700">{createMsg}</p>}
      </div>

      {showAdd && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            setCreateMsg(null);
            createUser.mutate();
          }}
          className="card-pad mb-6 grid gap-3 md:grid-cols-5"
        >
          <div>
            <label htmlFor="nu-email" className="field-label">Email</label>
            <input
              id="nu-email"
              type="email"
              required
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="field"
              placeholder="person@warwick.bm"
            />
          </div>
          <div>
            <label htmlFor="nu-name" className="field-label">Full name</label>
            <input
              id="nu-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="field"
              placeholder="Jane Doe"
            />
          </div>
          <div>
            <label htmlFor="nu-role" className="field-label">Role</label>
            <select
              id="nu-role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as UserRole)}
              className="field-select"
            >
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="nu-dept" className="field-label">Department</label>
            <DepartmentSelect
              id="nu-dept"
              role={newRole}
              value={newDept || null}
              onChange={(d) => setNewDept(d ?? '')}
              className="field-select"
            />
          </div>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={createUser.isPending || !newEmail.trim()}
              className="btn-primary w-full"
            >
              {createUser.isPending ? 'Sending invite…' : 'Send invite'}
            </button>
          </div>
          <p className="md:col-span-5 text-xs text-slate-500">
            An invitation email is sent via Supabase. The user sets their own password on first sign-in.
          </p>
        </form>
      )}

      {error && <p className="mb-4 alert-error">{error}</p>}
      {emulatingUser && (
        <form onSubmit={beginEmulation} className="card-pad mb-5 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">Emulate department account</h2>
            <p className="mt-1 text-sm text-slate-600">
              You will use {emulatingUser.full_name ?? emulatingUser.email}&apos;s account until you end emulation.
              This action is recorded in the audit log.
            </p>
          </div>
          <label htmlFor="emulation-reason" className="field-label">Reason (required)</label>
          <input
            id="emulation-reason"
            required
            minLength={5}
            maxLength={500}
            value={emulationReason}
            onChange={(event) => setEmulationReason(event.target.value)}
            className="field"
            placeholder="e.g. Reproduce a reported department workflow issue"
          />
          {emulationError && <p className="alert-error">{emulationError}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={isStartingEmulation || emulationReason.trim().length < 5} className="btn-primary">
              {isStartingEmulation ? 'Starting…' : 'Start emulation'}
            </button>
            <button
              type="button"
              disabled={isStartingEmulation}
              onClick={() => {
                setEmulatingUser(null);
                setEmulationReason('');
                setEmulationError(null);
              }}
              className="btn-ghost"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {isLoading && <p className="text-sm text-slate-500">Loading users…</p>}

      {data && (
        <>
          <div className="mb-3 flex gap-2">
            <button
              type="button"
              onClick={() => setView('staff')}
              className={view === 'staff' ? 'btn-primary' : 'btn-ghost'}
            >
              Department staff ({staff.length})
            </button>
            <button
              type="button"
              onClick={() => setView('submitters')}
              className={view === 'submitters' ? 'btn-primary' : 'btn-ghost'}
            >
              Submitters ({submitters.length})
            </button>
          </div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                {view === 'staff' && <th>Department</th>}
                {view === 'staff' && <th>Emulation</th>}
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td className="font-medium text-slate-800">
                    <Link to={`/admin/users/${u.id}`} className="hover:underline">
                      {u.full_name ?? '—'}
                    </Link>
                  </td>
                  <td className="text-slate-600">{u.email}</td>
                  <td>
                    <select
                      value={u.role}
                      disabled={updateProfile.isPending}
                      onChange={(e) =>
                        updateProfile.mutate({
                          id: u.id,
                          patch: { role: e.target.value as UserRole },
                        })
                      }
                      className="field-select-sm"
                    >
                      {ASSIGNABLE_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  {view === 'staff' && (
                    <td>
                      <DepartmentSelect
                        role={u.role}
                        value={u.department}
                        disabled={updateProfile.isPending}
                        onChange={(d) => updateProfile.mutate({ id: u.id, patch: { department: d } })}
                        className="field-select-sm"
                      />
                    </td>
                  )}
                  {view === 'staff' && (
                    <td>
                      {['it_tech', 'fac_tech', 'hs_officer', 'av_admin', 'manager'].includes(u.role) ? (
                        <button
                          type="button"
                          onClick={() => {
                            setEmulatingUser(u);
                            setEmulationReason('');
                            setEmulationError(null);
                          }}
                          className="btn-ghost px-3 py-1.5 text-xs"
                        >
                          Emulate
                        </button>
                      ) : <span className="text-xs text-slate-400">—</span>}
                    </td>
                  )}
                  <td className="text-xs text-slate-500">
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={view === 'staff' ? 6 : 4} className="text-center text-sm text-slate-400">
                    No users.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </>
      )}
    </section>
  );
}

/** Tech roles and submitters have a fixed department; managers pick one (or all). */
function DepartmentSelect({
  id,
  role,
  value,
  onChange,
  disabled,
  className,
}: {
  id?: string;
  role: UserRole;
  value: Department | null;
  onChange: (d: Department | null) => void;
  disabled?: boolean;
  className: string;
}) {
  const implied = ROLE_DEPARTMENT[role];
  if (role !== 'manager') {
    const label = implied ? DEPARTMENT_LABEL[implied] : '—';
    return <span id={id} className="text-sm text-slate-600">{label}</span>;
  }
  return (
    <select
      id={id}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange((e.target.value || null) as Department | null)}
      className={className}
    >
      <option value="">All departments</option>
      {DEPARTMENTS.map((d) => (
        <option key={d} value={d}>
          {DEPARTMENT_LABEL[d]}
        </option>
      ))}
    </select>
  );
}
