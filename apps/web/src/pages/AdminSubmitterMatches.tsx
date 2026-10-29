import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';

type SubmitterOption = {
  id: string;
  full_name: string | null;
  email: string;
};

type UnmatchedName = {
  legacy_name: string;
  ticket_count: number;
};

type ApprovedAlias = {
  id: string;
  profile_id: string;
  alias: string;
  created_at: string;
};

export default function AdminSubmitterMatches() {
  const { isAdmin, user, role } = useAuth();
  const queryClient = useQueryClient();
  const [selectedProfiles, setSelectedProfiles] = useState<Record<string, string>>({});
  const [profileSearch, setProfileSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const profilesQ = useQuery({
    queryKey: ['submitter-match-profiles'],
    enabled: isAdmin,
    queryFn: async (): Promise<SubmitterOption[]> => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data, error } = await supabase
        .from('profiles')
        .select('id,full_name,email')
        .eq('role', 'submitter')
        .order('full_name')
        .limit(1000);
      if (error) throw error;
      return (data ?? []) as SubmitterOption[];
    },
  });

  const unmatchedQ = useQuery({
    queryKey: ['unmatched-submitter-names'],
    enabled: isAdmin && !!supabase,
    queryFn: async (): Promise<UnmatchedName[]> => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data, error } = await supabase.rpc('admin_unmatched_submitter_names');
      if (error) throw error;
      return (data ?? []) as UnmatchedName[];
    },
  });

  const aliasesQ = useQuery({
    queryKey: ['approved-submitter-aliases'],
    enabled: isAdmin && !!supabase,
    queryFn: async (): Promise<ApprovedAlias[]> => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data, error } = await supabase
        .from('ticket_submitter_aliases')
        .select('id,profile_id,alias,created_at')
        .order('alias');
      if (error) throw error;
      return (data ?? []) as ApprovedAlias[];
    },
  });

  const profileById = useMemo(
    () => new Map((profilesQ.data ?? []).map((profile) => [profile.id, profile])),
    [profilesQ.data],
  );
  const visibleProfiles = useMemo(() => {
    const search = profileSearch.trim().toLowerCase();
    return (profilesQ.data ?? []).filter(
      (profile) =>
        !search ||
        profile.full_name?.toLowerCase().includes(search) ||
        profile.email.toLowerCase().includes(search),
    );
  }, [profileSearch, profilesQ.data]);

  const approveAlias = useMutation({
    mutationFn: async ({ alias, profileId }: { alias: string; profileId: string }) => {
      if (!supabase || !user) throw new Error('Supabase session required');
      const { error } = await supabase.from('ticket_submitter_aliases').insert({
        profile_id: profileId,
        alias,
        created_by: user.id,
      });
      if (error) throw error;
      return alias;
    },
    onSuccess: (alias) => {
      setSuccess(`Approved "${alias}" and associated its unlinked historical tickets.`);
      setError(null);
      setSelectedProfiles((current) => {
        const next = { ...current };
        delete next[alias];
        return next;
      });
      void queryClient.invalidateQueries({ queryKey: ['unmatched-submitter-names'] });
      void queryClient.invalidateQueries({ queryKey: ['approved-submitter-aliases'] });
      void queryClient.invalidateQueries({ queryKey: ['ticket-status-counts'] });
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
    },
    onError: (cause: Error) => {
      setSuccess(null);
      setError(cause.message);
    },
  });

  if (!isAdmin) {
    return <p className="alert-warn">Admins only. Your role: {role ?? 'unknown'}.</p>;
  }

  const pageError = profilesQ.error || unmatchedQ.error || aliasesQ.error;

  return (
    <section className="space-y-6">
      <header className="page-header">
        <div>
          <h1 className="page-title">Historical submitter matches</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Tickets are linked automatically when a stored email matches or a legacy submitter
            name uniquely matches an account. Review the remaining names and approve only verified
            account associations. Approved matches also apply to future imports.
          </p>
          <p className="mt-2 max-w-3xl text-xs text-amber-800">
            Approval gives the selected account access to all unlinked tickets with that historical
            name. Confirm the identity before approving; existing links are not changed.
          </p>
        </div>
      </header>

      {pageError && <p className="alert-error">{(pageError as Error).message}</p>}
      {error && <p role="alert" className="alert-error">{error}</p>}
      {success && <p role="status" className="alert-success">{success}</p>}

      {unmatchedQ.isLoading || profilesQ.isLoading ? (
        <p className="text-sm text-slate-500">Loading submitter names…</p>
      ) : (
        <div className="card-pad">
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="section-title">Unmatched historical names</h2>
            <span className="text-sm text-slate-500">
              {unmatchedQ.data?.length ?? 0} name groups
            </span>
          </div>
          <label className="mb-4 block max-w-md">
            <span className="field-label">Find a submitter account</span>
            <input
              type="search"
              value={profileSearch}
              onChange={(event) => setProfileSearch(event.target.value)}
              placeholder="Search name or email…"
              className="field"
            />
          </label>
          {unmatchedQ.data?.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                    <th className="py-3 pr-4">Historical name</th>
                    <th className="py-3 pr-4">Unlinked tickets</th>
                    <th className="py-3 pr-4">Verified submitter account</th>
                    <th className="py-3">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {unmatchedQ.data.map((item) => {
                    const selectedProfile = selectedProfiles[item.legacy_name] ?? '';
                    return (
                      <tr
                        key={item.legacy_name}
                        className="border-b border-slate-100 align-middle"
                      >
                        <td className="py-3 pr-4 font-medium text-slate-800">
                          {item.legacy_name}
                        </td>
                        <td className="py-3 pr-4">{item.ticket_count}</td>
                        <td className="py-3 pr-4">
                          <select
                            aria-label={`Account for ${item.legacy_name}`}
                            className="field-select-sm min-w-64"
                            value={selectedProfile}
                            onChange={(event) =>
                              setSelectedProfiles((current) => ({
                                ...current,
                                [item.legacy_name]: event.target.value,
                              }))
                            }
                          >
                            <option value="">Select verified account…</option>
                            {visibleProfiles.map((profile) => (
                              <option key={profile.id} value={profile.id}>
                                {profile.full_name || profile.email} · {profile.email}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-3">
                          <button
                            type="button"
                            className="btn-primary whitespace-nowrap"
                            disabled={!selectedProfile || approveAlias.isPending}
                            onClick={() => {
                              setError(null);
                              setSuccess(null);
                              approveAlias.mutate({
                                alias: item.legacy_name,
                                profileId: selectedProfile,
                              });
                            }}
                          >
                            {approveAlias.isPending ? 'Associating…' : 'Approve match'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-state">All historical submitter names are associated.</p>
          )}
        </div>
      )}

      <div className="card-pad">
        <h2 className="section-title mb-4">Approved name variants</h2>
        {aliasesQ.isLoading ? (
          <p className="text-sm text-slate-500">Loading approved matches…</p>
        ) : aliasesQ.data?.length ? (
          <ul className="divide-y divide-slate-100">
            {aliasesQ.data.map((alias) => {
              const profile = profileById.get(alias.profile_id);
              return (
                <li
                  key={alias.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                >
                  <span className="font-medium text-slate-800">{alias.alias}</span>
                  <span className="text-slate-600">
                    {profile?.full_name || profile?.email || 'Submitter account unavailable'}
                    {profile?.email ? ` · ${profile.email}` : ''}
                  </span>
                  <span className="text-xs text-slate-500">
                    Approved {new Date(alias.created_at).toLocaleDateString()}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No name variants have been approved.</p>
        )}
      </div>
    </section>
  );
}
