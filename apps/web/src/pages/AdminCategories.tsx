import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import {
  DEPARTMENT_CATEGORY_ROOT,
  DEPARTMENT_LABEL,
  TICKET_DEPARTMENTS,
  type Category,
  type Profile,
  type TicketDepartment,
} from '../lib/types';

type CategoryRow = Category & { is_active: boolean };

const CROSS_DEPARTMENT_ROOTS: Record<TicketDepartment, Set<string>> = {
  IT: new Set(['facilities', 'health and safety']),
  FAC: new Set(['it', 'health and safety']),
  HS: new Set(['it', 'facilities']),
};

function normalizeCategoryName(name: string) {
  return name.toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
}

export default function AdminCategories() {
  const { isManager, isAdmin, profile } = useAuth();
  const qc = useQueryClient();
  const [dept, setDept] = useState<TicketDepartment>('IT');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const managerDepartment = profile?.department &&
    TICKET_DEPARTMENTS.includes(profile.department as TicketDepartment)
    ? profile.department as TicketDepartment
    : null;
  const visibleDepartments = isAdmin
    ? TICKET_DEPARTMENTS
    : managerDepartment
      ? [managerDepartment]
      : [];
  const selectedDepartment = isAdmin ? dept : managerDepartment;

  const q = useQuery({
    queryKey: ['admin-categories', isAdmin ? 'all' : managerDepartment ?? 'unassigned'],
    enabled: isAdmin || !!managerDepartment,
    queryFn: async (): Promise<CategoryRow[]> => {
      if (!supabase) throw new Error('not ready');
      let query = supabase
        .from('categories')
        .select('*')
        .order('department')
        .order('name');
      if (!isAdmin && managerDepartment) query = query.eq('department', managerDepartment);
      const { data, error } = await query;
      if (error) throw error;
      return data as CategoryRow[];
    },
  });

  const membersQ = useQuery({
    queryKey: ['category-members', visibleDepartments],
    enabled: isManager && visibleDepartments.length > 0,
    queryFn: async (): Promise<Profile[]> => {
      if (!supabase) throw new Error('not ready');
      const { data, error } = await supabase
        .from('profiles')
        .select('id, email, full_name, role, department, created_at')
        .in('department', visibleDepartments);
      if (error) throw error;
      return data as Profile[];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!supabase) throw new Error('not ready');
      if (!selectedDepartment) throw new Error('No support department is assigned to your profile.');
      const parent = q.data?.find(
        (category) =>
          category.department === selectedDepartment &&
          category.parent_id === null &&
          normalizeCategoryName(category.name) ===
            normalizeCategoryName(DEPARTMENT_CATEGORY_ROOT[selectedDepartment]) &&
          category.is_active,
      );
      if (!parent) throw new Error('The department category is not available.');
      if (
        CROSS_DEPARTMENT_ROOTS[selectedDepartment].has(normalizeCategoryName(newName))
      ) {
        throw new Error('A department name cannot be added as a category under another department.');
      }
      const { error } = await supabase
        .from('categories')
        .insert({ department: selectedDepartment, name: newName.trim(), parent_id: parent.id });
      if (error) throw error;
    },
    onSuccess: () => {
      setNewName('');
      qc.invalidateQueries({ queryKey: ['admin-categories'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const update = useMutation({
    mutationFn: async (patch: {
      id: string;
      name?: string;
      is_active?: boolean;
      default_assignee_id?: string | null;
    }) => {
      if (!supabase) throw new Error('not ready');
      const { id, ...fields } = patch;
      const { error } = await supabase.from('categories').update(fields).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-categories'] }),
    onError: (e: Error) => setError(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) throw new Error('not ready');
      const { error } = await supabase.from('categories').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-categories'] }),
    onError: (e: Error) => setError(e.message),
  });

  const grouped = useMemo(() => {
    const g: Record<TicketDepartment, { parent: CategoryRow; children: CategoryRow[] }[]> = {
      IT: [],
      FAC: [],
      HS: [],
    };
    const byParent = new Map<string, CategoryRow[]>();
    for (const c of q.data ?? []) {
      if (c.parent_id) {
        const arr = byParent.get(c.parent_id) ?? [];
        arr.push(c);
        byParent.set(c.parent_id, arr);
      }
    }
    for (const c of q.data ?? []) {
      if (
        !c.parent_id &&
        TICKET_DEPARTMENTS.includes(c.department as TicketDepartment) &&
        normalizeCategoryName(c.name) ===
          normalizeCategoryName(DEPARTMENT_CATEGORY_ROOT[c.department as TicketDepartment])
      ) {
        g[c.department as TicketDepartment].push({ parent: c, children: byParent.get(c.id) ?? [] });
      }
    }
    return g;
  }, [q.data]);

  if (!isManager) return <p className="alert-warn">Manager or admin only.</p>;

  return (
    <section className="space-y-6">
      <header>
        <h1 className="page-title">Subcategories</h1>
        <p className="page-subtitle">
          Add or retire subcategories under Facilities, Health and Safety, or IT.
        </p>
      </header>

      {!isAdmin && !managerDepartment && (
        <p className="alert-warn">Your manager account has no support department assigned.</p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (newName.trim()) create.mutate();
        }}
        className="card flex flex-wrap items-end gap-3 p-6"
      >
        <div>
          <label htmlFor="cat-dept" className="field-label">
            Department
          </label>
          {isAdmin ? (
            <select
              id="cat-dept"
              value={dept}
              onChange={(e) => {
                setDept(e.target.value as TicketDepartment);
              }}
              className="field-select"
            >
              {TICKET_DEPARTMENTS.map((d) => (
                <option key={d} value={d}>{DEPARTMENT_LABEL[d]}</option>
              ))}
            </select>
          ) : (
            <p className="field flex min-w-40 items-center">{managerDepartment ? DEPARTMENT_LABEL[managerDepartment] : 'Unassigned'}</p>
          )}
        </div>
        <div className="flex-1">
          <label htmlFor="cat-new" className="field-label">
            New subcategory name
          </label>
          <input
            id="cat-new"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="field"
            placeholder="e.g. Printer / photocopier"
          />
        </div>
        <button
          type="submit"
          disabled={!newName.trim() || create.isPending || !selectedDepartment}
          className="btn-primary"
        >
          Add subcategory
        </button>
      </form>

      {error && <p className="alert-error">{error}</p>}

      <div className="grid gap-4">
        {visibleDepartments.map((d) => (
          <div key={d} className="card overflow-hidden">
            <h2 className="border-b border-slate-100 px-5 py-3 text-sm font-semibold text-brand-navy">
              {DEPARTMENT_LABEL[d]}{' '}
              <span className="text-xs font-normal text-slate-400">
                ({grouped[d].reduce((count, group) => count + group.children.length, 0)})
              </span>
            </h2>
            <ul className="divide-y divide-slate-100">
              {grouped[d].map(({ parent, children }) => (
                <li key={parent.id} className="px-4 py-2.5">
                  {children.length > 0 && (
                    <ul className="mt-2 space-y-1 border-l-2 border-slate-200 pl-3">
                      {children.map((sub) => (
                        <li key={sub.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto]">
                          <input
                            aria-label={`Subcategory name: ${sub.name}`}
                            title={sub.name}
                            defaultValue={sub.name}
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v && v !== sub.name) update.mutate({ id: sub.id, name: v });
                            }}
                            className={`field-sm col-span-3 min-w-0 w-full text-sm md:col-span-1 ${sub.is_active ? '' : 'text-slate-400 line-through'}`}
                          />
                          <select
                            aria-label={`Assign ${sub.name}`}
                            value={sub.default_assignee_id ?? ''}
                            onChange={(e) => update.mutate({
                              id: sub.id,
                              default_assignee_id: e.target.value || null,
                            })}
                            className="field-select-sm min-w-0 w-full text-sm"
                          >
                            <option value="">Unassigned</option>
                            {(membersQ.data ?? [])
                              .filter((member) => member.department === sub.department)
                              .map((member) => (
                                <option key={member.id} value={member.id}>
                                  {member.full_name || member.email}
                                </option>
                              ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => update.mutate({ id: sub.id, is_active: !sub.is_active })}
                            className="rounded-md border border-slate-200 px-2 py-0.5 text-xs text-slate-500 transition hover:bg-slate-100"
                          >
                            {sub.is_active ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (window.confirm(`Delete "${sub.name}"? Tickets using it will no longer have a subcategory.`)) {
                                remove.mutate(sub.id);
                              }
                            }}
                            className="rounded-md border border-rose-200 px-2 py-0.5 text-xs text-rose-700 transition hover:bg-rose-50"
                          >
                            Delete
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
              {grouped[d].length === 0 && (
                <li className="px-4 py-4 text-center text-xs text-slate-400">
                  No categories yet.
                </li>
              )}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
