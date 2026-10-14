import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import type { Location } from '../lib/types';

type LocationRow = Location & { is_active: boolean };
const PAGE_SIZE = 100;

export default function AdminLocations() {
  const { isManager, isAdmin } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [newLabel, setNewLabel] = useState('');
  const [error, setError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['admin-locations', search, page],
    queryFn: async (): Promise<{ rows: LocationRow[]; count: number }> => {
      if (!supabase) throw new Error('not ready');
      let req = supabase.from('locations').select('*', { count: 'exact' });
      if (search.trim()) req = req.ilike('building', `%${search.trim()}%`);
      req = req.order('building').range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      const { data, error, count } = await req;
      if (error) throw error;
      return { rows: (data ?? []) as LocationRow[], count: count ?? 0 };
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!supabase) throw new Error('not ready');
      const { error } = await supabase
        .from('locations')
        .insert({ building: newLabel.trim(), floor: null, room: null });
      if (error) throw error;
    },
    onSuccess: () => {
      setNewLabel('');
      qc.invalidateQueries({ queryKey: ['admin-locations'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const update = useMutation({
    mutationFn: async (patch: { id: string; building?: string; is_active?: boolean }) => {
      if (!supabase) throw new Error('not ready');
      const { id, ...fields } = patch;
      const { error } = await supabase.from('locations').update(fields).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-locations'] }),
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) throw new Error('not ready');
      const { error } = await supabase.from('locations').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-locations'] }),
    onError: (e: Error) => setError(e.message),
  });

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((q.data?.count ?? 0) / PAGE_SIZE)),
    [q.data?.count],
  );

  if (!isManager) return <p className="alert-warn">Manager or admin only.</p>;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="page-title">Locations</h1>
        <p className="page-subtitle">Buildings &amp; rooms. {q.data?.count ?? 0} total.</p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (newLabel.trim()) create.mutate();
        }}
        className="card flex flex-wrap items-end gap-3 p-6"
      >
        <div className="flex-1">
          <label htmlFor="loc-search" className="field-label">
            Search
          </label>
          <input
            id="loc-search"
            value={search}
            onChange={(e) => {
              setPage(0);
              setSearch(e.target.value);
            }}
            placeholder="search locations…"
            className="field"
          />
        </div>
        <div className="flex-1">
          <label htmlFor="loc-new" className="field-label">
            New location
          </label>
          <input
            id="loc-new"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="e.g. North Building / 2 / 203"
            className="field"
          />
        </div>
        <button
          type="submit"
          disabled={!newLabel.trim() || create.isPending}
          className="btn-primary"
        >
          Add location
        </button>
      </form>

      {error && <p className="alert-error">{error}</p>}

      <div className="card overflow-hidden">
        <ul className="divide-y divide-slate-100">
          {(q.data?.rows ?? []).map((l) => (
            <li key={l.id} className="flex items-center gap-2 px-4 py-2.5">
              <input
                defaultValue={l.building}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== l.building) update.mutate({ id: l.id, building: v });
                }}
                className={`field-sm flex-1 ${l.is_active ? '' : 'text-slate-400 line-through'}`}
              />
              <button
                type="button"
                onClick={() => update.mutate({ id: l.id, is_active: !l.is_active })}
                className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100"
              >
                {l.is_active ? 'Disable' : 'Enable'}
              </button>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete "${l.building}"? Tickets using it will no longer have a location.`)) {
                      remove.mutate(l.id);
                    }
                  }}
                  className="rounded-md border border-rose-200 px-2 py-1 text-xs font-medium text-rose-700 transition hover:bg-rose-50"
                >
                  Delete
                </button>
              )}
            </li>
          ))}
          {q.data && q.data.rows.length === 0 && (
            <li className="px-4 py-6 text-center text-sm text-slate-500">No locations match.</li>
          )}
        </ul>
      </div>

      <div className="flex items-center justify-between text-sm text-slate-600">
        <span>
          Page {page + 1} of {totalPages}
        </span>
        <div className="flex gap-2">
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium transition hover:bg-slate-50 disabled:opacity-40"
          >
            ← Prev
          </button>
          <button
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium transition hover:bg-slate-50 disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      </div>
    </section>
  );
}
