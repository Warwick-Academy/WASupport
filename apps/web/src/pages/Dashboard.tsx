import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { supabase } from '../lib/supabase';
import {
  DEPARTMENT_LABEL,
  PRIORITY_BADGE,
  PRIORITY_LABEL,
  ROLE_DEPARTMENT,
  STATUS_BADGE,
  STATUS_LABEL,
  TICKET_DEPARTMENTS,
  type Department,
  type Ticket,
  type TicketDepartment,
} from '../lib/types';
import { useAuth } from '../lib/auth';
import { useDepartmentKpis, type DepartmentKpis } from '../lib/useDepartmentKpis';
import SlaBadge from '../components/SlaBadge';

type RangePreset = 7 | 30 | 'custom';

type FlowRow = {
  day: string;
  department: string;
  still_open: number;
};
type LatestTicket = Pick<
  Ticket,
  | 'id'
  | 'ref'
  | 'legacy_ref'
  | 'department'
  | 'subject'
  | 'status'
  | 'priority'
  | 'created_at'
  | 'sla_due_at'
  | 'submitter_id'
  | 'assignee_id'
  | 'legacy_submitter_name'
  | 'legacy_assignee_name'
>;
type LatestProfile = { id: string; full_name: string | null; email: string };
type LatestSortKey = 'ref' | 'subject' | 'department' | 'submitter' | 'assignee' | 'priority' | 'status' | 'opened' | 'duration';
type SortDirection = 'asc' | 'desc';
type CategoryRow = { category: string; department: string; n: number };

const DEPT_COLORS: Record<Department, string> = {
  IT: '#f59e0b',
  FAC: '#0ea5e9',
  AV: '#8b5cf6',
  HS: '#10b981',
};
const DEPT_SERIES_COLORS: Record<
  Department,
  { opened: string; closed: string; stillOpen: string }
> = {
  IT: { opened: '#fbbf24', closed: '#b45309', stillOpen: '#f97316' },
  FAC: { opened: '#7dd3fc', closed: '#0369a1', stillOpen: '#0ea5e9' },
  AV: { opened: '#c4b5fd', closed: '#6d28d9', stillOpen: '#8b5cf6' },
  HS: { opened: '#6ee7b7', closed: '#047857', stillOpen: '#10b981' },
};
const CATEGORY_COLORS = [
  '#f59e0b', '#0ea5e9', '#10b981', '#8b5cf6', '#ef4444', '#ec4899',
  '#14b8a6', '#f97316', '#6366f1', '#84cc16', '#a855f7', '#06b6d4',
];
const PRIORITY_ORDER = { low: 0, normal: 1, high: 2, critical: 3, urgent: 4 } as const;
const STATUS_ORDER = {
  awaiting_triage: 0, open: 1, in_progress: 2, on_hold: 3, resolved: 4, closed: 5,
} as const;

function isoDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function rangeBounds(days: 7 | 30): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - (days - 1));
  return { from: isoDate(from), to: isoDate(to) };
}

function formatTicketDuration(createdAt: string): string {
  let minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000));
  const days = Math.floor(minutes / 1440);
  minutes %= 1440;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${remainingMinutes}m`]
    .filter(Boolean)
    .join(' ');
}

function DeltaArrow({ current, previous }: { current: number; previous: number }) {
  if (previous === 0 && current === 0) return null;
  const delta = current - previous;
  const positive = delta >= 0;
  return (
    <span
      className={`ml-2 text-sm font-medium ${positive ? 'text-emerald-600' : 'text-rose-600'}`}
      title={`Previous period: ${previous}`}
    >
      {positive ? '▲' : '▼'} {Math.abs(delta)}
    </span>
  );
}

function KpiTile({
  label,
  rows,
  departments,
  metric,
  previousMetric,
  to,
}: {
  label: string;
  rows: DepartmentKpis[];
  departments: Department[];
  metric: 'new_tickets' | 'open_tickets' | 'unassigned' | 'resolved_tickets' | 'uncategorized_tickets';
  previousMetric?: 'new_tickets_prev' | 'resolved_prev';
  to: string;
}) {
  return (
    <Link
      to={to}
      className="block rounded-lg border border-slate-200 border-l-[3px] border-l-brand-navy bg-white px-3 py-2.5 shadow-card transition hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy focus-visible:ring-offset-2"
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-1 space-y-0.5">
        {departments.length === 0 ? (
          <p className="py-0.5 text-xs text-slate-500">Select a department</p>
        ) : departments.map((department) => {
          const row = rows.find((item) => item.department === department);
          const value = Number(row?.[metric] ?? 0);
          const previous = previousMetric && row ? Number(row[previousMetric]) : undefined;
          return (
            <div key={department} className="flex items-baseline justify-between gap-1">
              <span className="truncate text-[11px] text-slate-600">{DEPARTMENT_LABEL[department]}</span>
              <span className="text-2xl font-bold leading-none text-slate-900">
                {value}
                {previous !== undefined && <DeltaArrow current={value} previous={previous} />}
              </span>
            </div>
          );
        })}
      </div>
    </Link>
  );
}

export default function Dashboard() {
  const { isManager, isAdmin, profile, user, role, isTicketStaff } = useAuth();
  const queryClient = useQueryClient();
  const initialRange = rangeBounds(7);
  const [range, setRange] = useState<RangePreset>(7);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [draftFrom, setDraftFrom] = useState(initialRange.from);
  const [draftTo, setDraftTo] = useState(initialRange.to);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [selectedDepartments, setSelectedDepartments] = useState<Department[]>(['IT', 'FAC', 'HS']);
  const [latestSortKey, setLatestSortKey] = useState<LatestSortKey>('opened');
  const [latestSortDirection, setLatestSortDirection] = useState<SortDirection>('desc');
  const visibleDepartments = isAdmin || role === 'leadership' || role === 'support'
    ? TICKET_DEPARTMENTS
    : role === 'manager'
      ? profile?.department && TICKET_DEPARTMENTS.includes(profile.department as TicketDepartment)
        ? [profile.department as TicketDepartment]
        : []
      : role && ROLE_DEPARTMENT[role] && TICKET_DEPARTMENTS.includes(ROLE_DEPARTMENT[role] as TicketDepartment)
        ? [ROLE_DEPARTMENT[role] as TicketDepartment]
        : [];
  const chartDepartments = selectedDepartments.filter((department) => visibleDepartments.includes(department as TicketDepartment));

  function selectPreset(days: 7 | 30) {
    const bounds = rangeBounds(days);
    setRange(days);
    setFrom(bounds.from);
    setTo(bounds.to);
    setDraftFrom(bounds.from);
    setDraftTo(bounds.to);
    setRangeError(null);
  }

  function applyCustomRange() {
    if (!draftFrom || !draftTo) {
      setRangeError('Select both a start date and an end date.');
      return;
    }
    if (draftFrom > draftTo) {
      setRangeError('The start date must be on or before the end date.');
      return;
    }
    const days = Math.floor((Date.parse(draftTo) - Date.parse(draftFrom)) / 86_400_000) + 1;
    if (days > 180) {
      setRangeError('Select a range of 180 days or fewer.');
      return;
    }
    setRange('custom');
    setFrom(draftFrom);
    setTo(draftTo);
    setRangeError(null);
  }

  const kpisQ = useDepartmentKpis(from, to, true, user?.id);

  const flowQ = useQuery({
    queryKey: ['dashboard-flow', from, to],
    queryFn: async (): Promise<FlowRow[]> => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data, error } = await supabase.rpc('dashboard_ticket_flow', {
        from_date: from,
        to_date: to,
      });
      if (error) throw error;
      return (data ?? []) as FlowRow[];
    },
  });

  const categoryQ = useQuery({
    queryKey: ['dashboard-categories', from, to],
    queryFn: async (): Promise<CategoryRow[]> => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data, error } = await supabase.rpc('dashboard_category_breakdown', {
        from_date: from,
        to_date: to,
      });
      if (error) throw error;
      return (data ?? []) as CategoryRow[];
    },
  });

  const selectedFlow = useMemo(
    () => (flowQ.data ?? []).filter((row) => chartDepartments.includes(row.department as Department)),
    [flowQ.data, chartDepartments],
  );

  // Pivot the daily flow into one end-of-day open-balance line per department.
  const flowByDay = useMemo(() => {
    const map = new Map<string, Record<string, number | string>>();
    for (const r of selectedFlow) {
      const existing = map.get(r.day) ?? { day: r.day };
      existing[`${r.department}_still_open`] = r.still_open;
      map.set(r.day, existing);
    }
    return Array.from(map.values()).sort((a, b) =>
      String(a.day).localeCompare(String(b.day)),
    );
  }, [selectedFlow]);

  const categoryTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of categoryQ.data ?? []) {
      if (!chartDepartments.includes(r.department as Department)) continue;
      if (r.category.toLowerCase() === 'uncategorised') continue;
      map.set(r.category, (map.get(r.category) ?? 0) + Number(r.n));
    }
    const sorted = Array.from(map.entries())
      .map(([category, n]) => ({ category, n }))
      .sort((left, right) => right.n - left.n);
    if (sorted.length <= 12) return sorted;
    const otherCount = sorted.slice(11).reduce((total, item) => total + item.n, 0);
    return [...sorted.slice(0, 11), { category: 'Other categories', n: otherCount }];
  }, [categoryQ.data, chartDepartments]);

  const errMsg =
    (kpisQ.error as Error | null)?.message ??
    (flowQ.error as Error | null)?.message ??
    (categoryQ.error as Error | null)?.message ??
    null;

  const latestTicketsQ = useQuery({
    queryKey: ['dashboard-latest-tickets', user?.id, chartDepartments.join(',')],
    enabled: !!supabase && chartDepartments.length > 0,
    queryFn: async (): Promise<LatestTicket[]> => {
      if (!supabase || chartDepartments.length === 0) return [];
      const { data, error } = await supabase
        .from('tickets')
        .select('id,ref,legacy_ref,department,subject,status,priority,created_at,sla_due_at,submitter_id,assignee_id,legacy_submitter_name,legacy_assignee_name')
        .in('department', chartDepartments)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return (data ?? []) as LatestTicket[];
    },
  });

  const latestProfileIds = Array.from(new Set(
    (latestTicketsQ.data ?? [])
      .flatMap((ticket) => [ticket.submitter_id, ticket.assignee_id])
      .filter((id): id is string => !!id),
  ));
  const latestPeopleQ = useQuery({
    queryKey: ['dashboard-latest-people', user?.id, latestProfileIds.sort().join(',')],
    enabled: !!supabase && latestProfileIds.length > 0,
    queryFn: async (): Promise<Record<string, string>> => {
      if (!supabase) return {};
      const { data, error } = await supabase
        .from('profiles')
        .select('id,full_name,email')
        .in('id', latestProfileIds);
      if (error) throw error;
      return Object.fromEntries((data ?? []).map((person) => [person.id, person.full_name ?? person.email]));
    },
  });

  const latestAssigneesQ = useQuery({
    queryKey: ['dashboard-latest-assignees', user?.id],
    enabled: isTicketStaff && !!supabase,
    queryFn: async (): Promise<Array<LatestProfile & { role: string; department: Department | null }>> => {
      if (!supabase) return [];
      const { data, error } = await supabase.rpc('assignable_staff');
      if (error) throw error;
      return (data ?? []) as Array<LatestProfile & { role: string; department: Department | null }>;
    },
  });

  const assignLatestTicket = useMutation({
    mutationFn: async ({ ticketId, assigneeId }: { ticketId: string; assigneeId: string | null }) => {
      if (!supabase) throw new Error('Supabase not configured');
      const { error } = await supabase.from('tickets').update({ assignee_id: assigneeId }).eq('id', ticketId);
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['dashboard-latest-tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['department-kpis'] });
    },
  });

  const personName = (id: string | null, fallback: string | null) =>
    (id && latestPeopleQ.data?.[id]) || fallback || '—';
  const canAssignLatest = (ticket: LatestTicket) =>
    isTicketStaff && (isAdmin || isManager || (role !== null && ROLE_DEPARTMENT[role] === ticket.department));

  const latestRows = useMemo(() => {
    const valueFor = (ticket: LatestTicket): string | number => {
      switch (latestSortKey) {
        case 'ref': return ticket.ref;
        case 'subject': return ticket.subject;
        case 'department': return DEPARTMENT_LABEL[ticket.department];
        case 'submitter': return personName(ticket.submitter_id, ticket.legacy_submitter_name);
        case 'assignee': return personName(ticket.assignee_id, ticket.legacy_assignee_name);
        case 'priority': return PRIORITY_ORDER[ticket.priority];
        case 'status': return STATUS_ORDER[ticket.status];
        case 'opened': return new Date(ticket.created_at).getTime();
        case 'duration': return Date.now() - new Date(ticket.created_at).getTime();
      }
    };
    return [...(latestTicketsQ.data ?? [])].sort((left, right) => {
      const a = valueFor(left);
      const b = valueFor(right);
      const comparison = typeof a === 'number' && typeof b === 'number'
        ? a - b
        : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
      return latestSortDirection === 'asc' ? comparison : -comparison;
    });
  }, [latestTicketsQ.data, latestPeopleQ.data, latestSortDirection, latestSortKey]);

  function changeLatestSort(key: LatestSortKey) {
    if (key === latestSortKey) setLatestSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc');
    else {
      setLatestSortKey(key);
      setLatestSortDirection(key === 'opened' || key === 'duration' ? 'desc' : 'asc');
    }
  }

  function LatestSortHeading({ column, children, className }: {
    column: LatestSortKey;
    children: string;
    className?: string;
  }) {
    const active = latestSortKey === column;
    return (
      <th className={className} aria-sort={active ? (latestSortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" onClick={() => changeLatestSort(column)} className="inline-flex items-center gap-1 text-left hover:text-slate-900">
          <span>{children}</span>
          <span className={active ? 'text-slate-800' : 'text-slate-300'} aria-hidden="true">
            {active ? (latestSortDirection === 'asc' ? '▲' : '▼') : '↕'}
          </span>
        </button>
      </th>
    );
  }

  const drilldownUrl = (metric: 'new' | 'open' | 'unassigned' | 'resolved') =>
    `/tickets?view=${metric}&from=${from}&to=${to}`;

  return (
    <section>
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">Tech-team view of ticket activity.</p>
        </div>
        <div className="flex flex-wrap items-end justify-end gap-2">
          <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-sm">
            {([7, 30] as const).map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => selectPreset(days)}
                className={
                  'rounded px-3 py-1.5 ' +
                  (range === days
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900')
                }
              >
                Last {days} days
              </button>
            ))}
          </div>
          <div>
            <label htmlFor="dashboard-from" className="mb-1 block text-[11px] font-semibold uppercase text-slate-500">
              From
            </label>
            <input
              id="dashboard-from"
              type="date"
              value={draftFrom}
              max={draftTo || undefined}
              onChange={(event) => setDraftFrom(event.target.value)}
              className="field-sm"
            />
          </div>
          <div>
            <label htmlFor="dashboard-to" className="mb-1 block text-[11px] font-semibold uppercase text-slate-500">
              To
            </label>
            <input
              id="dashboard-to"
              type="date"
              value={draftTo}
              min={draftFrom || undefined}
              max={isoDate(new Date())}
              onChange={(event) => setDraftTo(event.target.value)}
              className="field-sm"
            />
          </div>
          <button type="button" onClick={applyCustomRange} className="btn-primary px-4 py-2">
            Apply
          </button>
        </div>
      </div>

      {rangeError && <p className="mb-4 alert-error">{rangeError}</p>}
      {errMsg && <p className="mb-4 alert-error">{errMsg}</p>}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <KpiTile
          label="New tickets"
          rows={kpisQ.data ?? []}
          departments={chartDepartments}
          metric="new_tickets"
          previousMetric="new_tickets_prev"
          to={drilldownUrl('new')}
        />
        <KpiTile
          label="Open at period end"
          rows={kpisQ.data ?? []}
          departments={chartDepartments}
          metric="open_tickets"
          to={drilldownUrl('open')}
        />
        <KpiTile
          label="Unassigned at period end"
          rows={kpisQ.data ?? []}
          departments={chartDepartments}
          metric="unassigned"
          to={drilldownUrl('unassigned')}
        />
        <KpiTile
          label="Closed"
          rows={kpisQ.data ?? []}
          departments={chartDepartments}
          metric="resolved_tickets"
          previousMetric="resolved_prev"
          to={drilldownUrl('resolved')}
        />
        <KpiTile
          label="Uncategorised · last month"
          rows={kpisQ.data ?? []}
          departments={chartDepartments}
          metric="uncategorized_tickets"
          to="/tickets?view=uncategorized"
        />
      </div>

      <fieldset className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <legend className="px-1 text-xs font-semibold uppercase text-slate-600">Departments shown in charts</legend>
        {visibleDepartments.map((department) => (
          <label key={department} className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={chartDepartments.includes(department)}
              onChange={(event) => {
                setSelectedDepartments((current) => {
                  const visibleCurrent = current.filter((item) => visibleDepartments.includes(item as TicketDepartment));
                  return event.target.checked
                    ? [...visibleCurrent, department]
                    : visibleCurrent.filter((item) => item !== department);
                });
              }}
              className="h-4 w-4 accent-slate-800"
            />
            {DEPARTMENT_LABEL[department]}
          </label>
        ))}
      </fieldset>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="card-pad lg:col-span-2">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-700">
            Ticket history
          </h2>
          <p className="mb-2 text-xs text-slate-500">
            Tickets open at the end of each day.
          </p>
          <div className="h-72">
            {chartDepartments.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">
                Select a department to display ticket history.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={flowByDay}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend
                    content={() => (
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs">
                        {chartDepartments.flatMap((department) => [
                          {
                            key: `${department}_still_open`,
                            label: DEPARTMENT_LABEL[department],
                            color: DEPT_SERIES_COLORS[department].stillOpen,
                            line: 'dashed' as const,
                          },
                        ]).map((item) => (
                          <span key={item.key} className="inline-flex items-center gap-1.5 text-slate-700">
                            <span
                              aria-hidden="true"
                              className="inline-block w-5"
                              style={{ borderTopWidth: 2, borderTopStyle: item.line, borderTopColor: item.color }}
                            />
                            {item.label}
                          </span>
                        ))}
                      </div>
                    )}
                  />
                  {chartDepartments.map((d) => (
                    <Line
                      key={`${d}_still_open`}
                      type="monotone"
                      dataKey={`${d}_still_open`}
                      name={`${DEPARTMENT_LABEL[d]} open at day end`}
                      stroke={DEPT_SERIES_COLORS[d].stillOpen}
                      strokeDasharray="8 4"
                      strokeWidth={2.5}
                      dot={{ r: 2 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="card-pad">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-700">
            Categories by department
          </h2>
          {categoryTotals.length === 0 ? (
            <div className="flex h-72 items-center justify-center text-center text-sm text-slate-500">
              No categorised tickets in this range and department selection.
            </div>
          ) : (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={categoryTotals}
                    dataKey="n"
                    nameKey="category"
                    innerRadius={50}
                    outerRadius={90}
                    paddingAngle={2}
                  >
                    {categoryTotals.map((_, i) => (
                      <Cell key={i} fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

      </div>

      <section className="mt-6">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Latest 20 tickets</h2>
          <span className="text-xs text-slate-500">Selected departments</span>
        </div>
        {chartDepartments.length === 0 ? (
          <p className="empty-state">Select a department to view its latest tickets.</p>
        ) : latestTicketsQ.isLoading ? (
          <p className="text-sm text-slate-500">Loading latest tickets…</p>
        ) : latestTicketsQ.error ? (
          <p className="alert-error">{(latestTicketsQ.error as Error).message}</p>
        ) : latestTicketsQ.data?.length === 0 ? (
          <p className="empty-state">No tickets found for the selected departments.</p>
        ) : (
          <>
            {assignLatestTicket.error && (
              <p className="mb-3 alert-error">Could not save assignment: {(assignLatestTicket.error as Error).message}</p>
            )}
            <div className="data-table-wrap">
              <table className="data-table whitespace-nowrap">
                <thead>
                  <tr>
                    <th scope="col" className="w-12">#</th>
                    <LatestSortHeading column="ref">Ref</LatestSortHeading>
                    <LatestSortHeading column="subject">Subject</LatestSortHeading>
                    <LatestSortHeading column="department">Department</LatestSortHeading>
                    <LatestSortHeading column="submitter">Submitted by</LatestSortHeading>
                    <LatestSortHeading column="assignee">Assigned to</LatestSortHeading>
                    <LatestSortHeading column="priority">Priority</LatestSortHeading>
                    <LatestSortHeading column="status">Status</LatestSortHeading>
                    <th>SLA</th>
                    <LatestSortHeading column="opened" className="min-w-[210px]">Opened</LatestSortHeading>
                    <LatestSortHeading column="duration">Duration</LatestSortHeading>
                  </tr>
                </thead>
                <tbody>
                  {latestRows.map((ticket, index) => (
                    <tr key={ticket.id}>
                      <td className="text-xs text-slate-500">{index + 1}</td>
                      <td>
                        <Link to={`/tickets/${ticket.id}`} className="ref-link">{ticket.ref}</Link>
                        {ticket.legacy_ref && <div className="mt-0.5 text-[10px] text-slate-400">SW #{ticket.legacy_ref}</div>}
                      </td>
                      <td className="max-w-64 truncate text-slate-700" title={ticket.subject}>{ticket.subject}</td>
                      <td className="text-slate-600">{DEPARTMENT_LABEL[ticket.department]}</td>
                      <td className="text-slate-700">{personName(ticket.submitter_id, ticket.legacy_submitter_name)}</td>
                      <td className="text-slate-700">
                        {canAssignLatest(ticket) ? (
                          <select
                            aria-label={`Assigned to for ${ticket.ref}`}
                            value={ticket.assignee_id ?? ''}
                            disabled={
                              latestAssigneesQ.isLoading || !!latestAssigneesQ.error ||
                              (assignLatestTicket.isPending && assignLatestTicket.variables?.ticketId === ticket.id)
                            }
                            title={latestAssigneesQ.error ? 'Unable to load department members.' : ''}
                            onChange={(event) => assignLatestTicket.mutate({
                              ticketId: ticket.id,
                              assigneeId: event.target.value || null,
                            })}
                            className="field-select-sm min-w-36 py-1 text-xs disabled:opacity-60"
                          >
                            <option value="">Unassigned</option>
                            {ticket.assignee_id &&
                              !latestAssigneesQ.data?.some(
                                (person) => person.id === ticket.assignee_id,
                              ) && (
                                <option value={ticket.assignee_id}>
                                  {personName(ticket.assignee_id, ticket.legacy_assignee_name)}
                                </option>
                              )}
                            {(latestAssigneesQ.data ?? []).map((person) => (
                              <option key={person.id} value={person.id}>
                                {person.full_name ?? person.email}
                              </option>
                            ))}
                          </select>
                        ) : personName(ticket.assignee_id, ticket.legacy_assignee_name)}
                      </td>
                      <td><span className={PRIORITY_BADGE[ticket.priority]}>{PRIORITY_LABEL[ticket.priority]}</span></td>
                      <td><span className={STATUS_BADGE[ticket.status]}>{STATUS_LABEL[ticket.status]}</span></td>
                      <td><SlaBadge slaDueAt={ticket.sla_due_at} status={ticket.status} /></td>
                      <td className="min-w-[210px] whitespace-nowrap text-xs text-slate-500">{new Date(ticket.created_at).toLocaleString()}</td>
                      <td className="text-xs text-slate-500">{formatTicketDuration(ticket.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

    </section>
  );
}
