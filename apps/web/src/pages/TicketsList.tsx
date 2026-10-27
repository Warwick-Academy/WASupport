import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import {
  DEPARTMENT_LABEL,
  PRIORITY_BADGE,
  PRIORITY_LABEL,
  STATUS_BADGE,
  STATUS_LABEL,
  ROLE_DEPARTMENT,
  TICKET_DEPARTMENTS,
  type Department,
  type Ticket,
  type TicketDepartment,
  type TicketPriority,
  type TicketStatus,
  type UserRole,
} from '../lib/types';

type Filter = 'mine' | 'all' | 'open_all' | 'open_dept' | 'closed_dept' | 'uncategorized';
type SortKey =
  | 'ref'
  | 'subject'
  | 'department'
  | 'submitter'
  | 'assignee'
  | 'priority'
  | 'status'
  | 'opened'
  | 'duration';
type SortDirection = 'asc' | 'desc';
type AvRequestSummary = {
  id: string;
  requested_date: string;
  setup_time: string;
  equipment: string[];
  location: string;
};
type AssigneeOption = { id: string; full_name: string | null; email: string };
type AssignablePerson = AssigneeOption & { role: UserRole; department: Department | null };

const CLOSED_STATUSES = ['resolved', 'closed'] as const;
const UNCATEGORIZED_PAGE_SIZE = 100;
const TICKET_LIST_COLUMNS =
  'id,ref,legacy_ref,department,subject,status,priority,submitter_id,assignee_id,created_at,legacy_submitter_name,legacy_assignee_name';
const ASSIGNEE_ROLES: UserRole[] = [
  'it_tech',
  'fac_tech',
  'hs_officer',
  'av_admin',
  'manager',
  'admin',
];
const PRIORITY_ORDER = { low: 0, normal: 1, high: 2, critical: 3, urgent: 4 } as const;
const STATUS_ORDER = {
  awaiting_triage: 0,
  open: 1,
  in_progress: 2,
  on_hold: 3,
  resolved: 4,
  closed: 5,
} as const;

const FILTER_DESCRIPTIONS: Record<Filter, string> = {
  mine: 'Tickets assigned to or submitted by you.',
  all: 'Every ticket you have access to.',
  open_all: 'Open tickets across all departments.',
  open_dept: 'Open tickets in your department.',
  closed_dept: 'Resolved and closed tickets in your department.',
  uncategorized: 'Tickets without a category.',
};

function formatDuration(fromIso: string, toIso: string | null): string {
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  let ms = Math.max(0, to - from);
  const day = 24 * 60 * 60 * 1000;
  const hr = 60 * 60 * 1000;
  const min = 60 * 1000;
  const days = Math.floor(ms / day);
  ms -= days * day;
  const hours = Math.floor(ms / hr);
  ms -= hours * hr;
  const mins = Math.floor(ms / min);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default function TicketsList() {
  const { user, profile, isTicketStaff, isAdmin, isManager, isAvAdmin, role } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = searchParams.get('view');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const dashboardView =
    isTicketStaff &&
    view &&
    ['new', 'open', 'unassigned', 'resolved'].includes(view) &&
    from &&
    to &&
    /^\d{4}-\d{2}-\d{2}$/.test(from) &&
    /^\d{4}-\d{2}-\d{2}$/.test(to)
      ? view
      : null;
  const [filter, setFilter] = useState<Filter>(() =>
    view && ['mine', 'all', 'open_all', 'open_dept', 'closed_dept', 'uncategorized'].includes(view)
      ? (view as Filter)
      : isTicketStaff
        ? 'all'
        : 'mine',
  );
  const [selectedAssignee, setSelectedAssignee] = useState('all');
  const [status, setStatus] = useState<TicketStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [uncategorizedPage, setUncategorizedPage] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('opened');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const uncategorizedCutoff = useMemo(() => {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 1);
    return dateKey(cutoff);
  }, []);
  const requestedDepartment = searchParams.get('department');
  const initialDepartment =
    requestedDepartment && TICKET_DEPARTMENTS.includes(requestedDepartment as TicketDepartment)
      ? (requestedDepartment as TicketDepartment)
      : 'all';
  const [selectedDepartment, setSelectedDepartment] = useState<TicketDepartment | 'all'>(
    initialDepartment,
  );
  const dept =
    profile?.department && TICKET_DEPARTMENTS.includes(profile.department as TicketDepartment)
      ? (profile.department as TicketDepartment)
      : null;
  const filterDepartment = selectedDepartment === 'all' ? dept : selectedDepartment;
  const hasDept = !!filterDepartment;
  const ticketCountsQ = useQuery({
    queryKey: ['ticket-status-counts', user?.id],
    enabled: !!user && !!supabase,
    retry: false,
    queryFn: async (): Promise<{
      open_tickets: number;
      closed_tickets: number;
      unassigned_tickets: number;
    }> => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data, error } = await supabase
        .rpc('ticket_status_counts')
        .abortSignal(AbortSignal.timeout(12_000));
      if (error) throw error;
      const counts = data?.[0];
      if (!counts) throw new Error('Ticket counts were not returned');
      return counts;
    },
  });

  const assignablePeopleQ = useQuery({
    queryKey: ['ticket-assignable-people', user?.id],
    enabled: isTicketStaff && !!supabase,
    queryFn: async (): Promise<AssignablePerson[]> => {
      if (!supabase) return [];
      const { data, error } = await supabase
        .from('profiles')
        .select('id,full_name,email,role,department')
        .in('role', ASSIGNEE_ROLES)
        .order('full_name', { ascending: true });
      if (error) throw error;
      return (data ?? []) as AssignablePerson[];
    },
  });

  const assignTicket = useMutation({
    mutationFn: async ({
      ticketId,
      assigneeId,
    }: {
      ticketId: string;
      assigneeId: string | null;
    }) => {
      if (!supabase) throw new Error('Supabase not configured');
      const { error } = await supabase
        .from('tickets')
        .update({ assignee_id: assigneeId })
        .eq('id', ticketId);
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['department-kpis'] });
      void queryClient.invalidateQueries({ queryKey: ['ticket-status-counts'] });
    },
  });

  const updatePriority = useMutation({
    mutationFn: async ({ ticketId, priority }: { ticketId: string; priority: TicketPriority }) => {
      if (!supabase) throw new Error('Supabase not configured');
      const { error } = await supabase.from('tickets').update({ priority }).eq('id', ticketId);
      if (error) throw error;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      void queryClient.invalidateQueries({ queryKey: ['department-kpis'] });
      void queryClient.invalidateQueries({ queryKey: ['ticket-status-counts'] });
    },
  });

  const {
    data: ticketResult,
    isLoading,
    error,
  } = useQuery({
    queryKey: [
      'tickets',
      filter,
      user?.id,
      dept,
      selectedDepartment,
      selectedAssignee,
      search,
      uncategorizedPage,
      uncategorizedCutoff,
      status,
      dashboardView,
      from,
      to,
    ],
    enabled: !!user,
    queryFn: async (): Promise<{ tickets: Ticket[]; count: number | null; hasNext: boolean }> => {
      if (!supabase) throw new Error('Supabase not configured');
      let q = dashboardView
        ? supabase.rpc(
            'dashboard_ticket_drilldown',
            {
              metric: dashboardView,
              from_date: from!,
              to_date: to!,
            },
            { count: 'exact' },
          )
        : supabase.from('tickets').select(TICKET_LIST_COLUMNS);

      if (!dashboardView && filter === 'mine') {
        if (isTicketStaff && user) {
          q = q.or(`assignee_id.eq.${user.id},submitter_id.eq.${user.id}`);
        } else if (user) {
          q = q.eq('submitter_id', user.id);
        }
      } else if (!dashboardView && filter === 'open_all') {
        q = q.not('status', 'in', `(${CLOSED_STATUSES.join(',')})`);
      } else if (!dashboardView && filter === 'open_dept') {
        if (!filterDepartment) return { tickets: [], count: 0, hasNext: false };
        q = q
          .eq('department', filterDepartment)
          .not('status', 'in', `(${CLOSED_STATUSES.join(',')})`);
      } else if (!dashboardView && filter === 'closed_dept') {
        if (!filterDepartment) return { tickets: [], count: 0, hasNext: false };
        q = q
          .eq('department', filterDepartment)
          .in('status', CLOSED_STATUSES as unknown as string[]);
      } else if (!dashboardView && filter === 'uncategorized') {
        q = q.is('category_id', null).gte('created_at', `${uncategorizedCutoff}T00:00:00.000Z`);
      }
      // 'all' applies no extra filter

      if (selectedDepartment !== 'all') q = q.eq('department', selectedDepartment);
      if (selectedAssignee === 'unassigned') q = q.is('assignee_id', null);
      else if (selectedAssignee !== 'all') q = q.eq('assignee_id', selectedAssignee);
      if (status !== 'all') q = q.eq('status', status);

      if (search.trim()) {
        const s = search.trim().replace(/[%_]/g, '');
        q = q.or(
          `subject.ilike.%${s}%,ref.ilike.%${s}%,legacy_ref.ilike.%${s}%,description.ilike.%${s}%,legacy_submitter_name.ilike.%${s}%`,
        );
      }

      q = q.order('created_at', { ascending: false }).order('id');
      q = q.range(
        uncategorizedPage * UNCATEGORIZED_PAGE_SIZE,
        uncategorizedPage * UNCATEGORIZED_PAGE_SIZE + UNCATEGORIZED_PAGE_SIZE,
      );

      const { data, error, count } = await q;
      if (error) throw error;
      const pageRows = data ?? [];
      return {
        tickets: pageRows.slice(0, UNCATEGORIZED_PAGE_SIZE) as Ticket[],
        count: dashboardView ? (count ?? pageRows.length) : null,
        hasNext: pageRows.length > UNCATEGORIZED_PAGE_SIZE,
      };
    },
  });
  const data = ticketResult?.tickets;

  function chooseFilter(nextFilter: Filter) {
    if (dashboardView) setSearchParams({ view: nextFilter });
    setFilter(nextFilter);
    setStatus('all');
    setUncategorizedPage(0);
  }

  function chooseDepartment(value: TicketDepartment | 'all') {
    setSelectedDepartment(value);
    setSelectedAssignee('all');
    setUncategorizedPage(0);
  }

  const avRequestsQ = useQuery({
    queryKey: ['my-av-request-summaries', user?.id, role],
    enabled: !!user && !!supabase && (role === 'submitter' || isAvAdmin),
    queryFn: async (): Promise<AvRequestSummary[]> => {
      if (!supabase || !user) return [];
      let request = supabase
        .from('av_requests')
        .select('id,requested_date,setup_time,equipment,location');
      if (!isAvAdmin) request = request.eq('requester_id', user.id);
      const { data: avRequests, error: avError } = await request.order('requested_date', {
        ascending: false,
      });
      if (avError) throw avError;
      return avRequests as AvRequestSummary[];
    },
  });

  const userIds = Array.from(
    new Set(
      (data ?? []).flatMap((t) => [t.submitter_id, t.assignee_id]).filter((x): x is string => !!x),
    ),
  );

  const { data: people } = useQuery({
    queryKey: ['ticket-list-profiles', userIds.sort().join(',')],
    enabled: userIds.length > 0 && !!supabase,
    queryFn: async (): Promise<Record<string, string>> => {
      if (!supabase) return {};
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email')
        .in('id', userIds);
      if (error) throw error;
      const map: Record<string, string> = {};
      for (const p of (data ?? []) as Array<{
        id: string;
        full_name: string | null;
        email: string;
      }>) {
        map[p.id] = p.full_name?.trim() || p.email;
      }
      return map;
    },
  });

  const nameFor = (id: string | null, fallback: string | null): string => {
    if (id && people && people[id]) return people[id];
    return fallback?.trim() || '—';
  };

  const sortedTickets = useMemo(() => {
    const tickets = [...(data ?? [])];
    const textCompare = (left: string, right: string) =>
      left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
    const valueFor = (ticket: Ticket): string | number => {
      switch (sortKey) {
        case 'ref':
          return ticket.ref;
        case 'subject':
          return ticket.subject;
        case 'department':
          return DEPARTMENT_LABEL[ticket.department];
        case 'submitter':
          return nameFor(ticket.submitter_id, ticket.legacy_submitter_name);
        case 'assignee':
          return nameFor(ticket.assignee_id, ticket.legacy_assignee_name);
        case 'priority':
          return PRIORITY_ORDER[ticket.priority];
        case 'status':
          return STATUS_ORDER[ticket.status];
        case 'opened':
          return new Date(ticket.created_at).getTime();
        case 'duration':
          return Date.now() - new Date(ticket.created_at).getTime();
      }
    };
    tickets.sort((left, right) => {
      const leftValue = valueFor(left);
      const rightValue = valueFor(right);
      const comparison =
        typeof leftValue === 'number' && typeof rightValue === 'number'
          ? leftValue - rightValue
          : textCompare(String(leftValue), String(rightValue));
      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return tickets;
  }, [data, people, sortDirection, sortKey]);

  function changeSort(key: SortKey) {
    if (key === sortKey) {
      setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection(key === 'opened' || key === 'duration' ? 'desc' : 'asc');
    }
  }

  function SortHeading({
    column,
    children,
    className,
  }: {
    column: SortKey;
    children: string;
    className?: string;
  }) {
    const active = sortKey === column;
    return (
      <th
        className={className}
        aria-sort={active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button
          type="button"
          onClick={() => changeSort(column)}
          className="inline-flex items-center gap-1 text-left hover:text-slate-900"
        >
          <span>{children}</span>
          <span className={active ? 'text-slate-800' : 'text-slate-300'} aria-hidden="true">
            {active ? (sortDirection === 'asc' ? '▲' : '▼') : '↕'}
          </span>
        </button>
      </th>
    );
  }

  const pillBase =
    'rounded-full border px-3 py-1 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-offset-1';
  const pillActive = 'border-slate-900 bg-slate-900 text-white';
  const pillIdle = 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50';
  const pillDisabled = 'cursor-not-allowed border-slate-200 bg-slate-100 text-slate-400';

  const deptLabel = filterDepartment ? DEPARTMENT_LABEL[filterDepartment] : 'your department';
  const assigneesFor = (department: Department) =>
    (assignablePeopleQ.data ?? []).filter(
      (person) =>
        person.role === 'admin' ||
        person.role === 'manager' ||
        ROLE_DEPARTMENT[person.role] === department,
    );
  const canManageTicket = (ticket: Ticket) =>
    isTicketStaff &&
    (isAdmin || isManager || (role !== null && ROLE_DEPARTMENT[role] === ticket.department));
  const filterAssignees =
    selectedDepartment === 'all'
      ? dept
        ? assigneesFor(dept)
        : (assignablePeopleQ.data ?? [])
      : assigneesFor(selectedDepartment);

  return (
    <section>
      <div className="page-header">
        <div>
          <h1 className="page-title">Tickets</h1>
          <p className="text-sm italic text-slate-500">
            {dashboardView
              ? `${({ new: 'New tickets', open: 'Open at period end', unassigned: 'Unassigned at period end', resolved: 'Closed tickets' } as Record<string, string>)[dashboardView]} from ${from} to ${to}.`
              : FILTER_DESCRIPTIONS[filter]}
          </p>
          {dashboardView && (
            <Link to="/dashboard" className="text-sm text-brand-navy hover:underline">
              Back to dashboard
            </Link>
          )}
        </div>
        <Link to="/new" className="btn-primary">
          + Submit a new ticket
        </Link>
      </div>

      <section className="mb-3" aria-label="Ticket counts">
        {ticketCountsQ.error ? (
          <div className="mb-2 alert-error" role="alert">
            <p>Ticket statistics could not load: {(ticketCountsQ.error as Error).message}</p>
            <button
              type="button"
              className="mt-1 font-semibold underline"
              onClick={() => void ticketCountsQ.refetch()}
            >
              Retry statistics
            </button>
          </div>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {(
            [
              ['Open tickets', ticketCountsQ.data?.open_tickets],
              ['Closed tickets', ticketCountsQ.data?.closed_tickets],
              ['Unassigned tickets', ticketCountsQ.data?.unassigned_tickets],
            ] as const
          ).map(([label, count]) => (
            <div
              key={label}
              className="rounded-lg border border-slate-200 border-l-[3px] border-l-brand-navy bg-white px-4 py-3 shadow-card"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {label}
              </p>
              <p className="mt-1 text-3xl font-bold leading-none text-slate-900">
                {count === undefined
                  ? ticketCountsQ.isError
                    ? 'Unavailable'
                    : 'Loading…'
                  : Number(count).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      </section>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setUncategorizedPage(0);
          }}
          placeholder="search subject / ref / description…"
          className="field-sm w-72"
        />
        {isTicketStaff && (
          <>
            <label htmlFor="ticket-department-filter" className="sr-only">
              Department
            </label>
            <select
              id="ticket-department-filter"
              value={selectedDepartment}
              onChange={(event) => chooseDepartment(event.target.value as TicketDepartment | 'all')}
              className="field-select-sm min-w-40"
            >
              <option value="all">All departments</option>
              {TICKET_DEPARTMENTS.map((department) => (
                <option key={department} value={department}>
                  {DEPARTMENT_LABEL[department]}
                </option>
              ))}
            </select>
            <label htmlFor="ticket-assignee-filter" className="sr-only">
              Assigned to
            </label>
            <select
              id="ticket-assignee-filter"
              value={selectedAssignee}
              onChange={(event) => {
                setSelectedAssignee(event.target.value);
                setUncategorizedPage(0);
              }}
              disabled={assignablePeopleQ.isLoading}
              className="field-select-sm min-w-44 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="all">All assignees</option>
              <option value="unassigned">Unassigned</option>
              {filterAssignees.map((assignee) => (
                <option key={assignee.id} value={assignee.id}>
                  {assignee.full_name ?? assignee.email}
                </option>
              ))}
            </select>
            <select
              aria-label="Ticket status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as TicketStatus | 'all');
                setUncategorizedPage(0);
              }}
              className="field-select-sm"
            >
              <option value="all">All statuses</option>
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="in_progress">In progress</option>
              <option value="awaiting_triage">Needs review</option>
              <option value="on_hold">On hold</option>
              <option value="resolved">Resolved</option>
            </select>
          </>
        )}
        <button
          type="button"
          onClick={() => chooseFilter('mine')}
          className={`${pillBase} ${!dashboardView && filter === 'mine' ? pillActive : pillIdle}`}
        >
          My tickets
        </button>
        <button
          type="button"
          onClick={() => chooseFilter('all')}
          className={`${pillBase} ${!dashboardView && filter === 'all' ? pillActive : pillIdle}`}
        >
          All tickets
        </button>
        <button
          type="button"
          onClick={() => chooseFilter('open_all')}
          className={`${pillBase} ${!dashboardView && filter === 'open_all' ? pillActive : pillIdle}`}
        >
          Open · All departments
        </button>
        <button
          type="button"
          onClick={() => hasDept && chooseFilter('open_dept')}
          disabled={!hasDept}
          title={hasDept ? '' : 'No department assigned to your profile.'}
          className={`${pillBase} ${
            !hasDept ? pillDisabled : filter === 'open_dept' ? pillActive : pillIdle
          }`}
        >
          Open · {deptLabel}
        </button>
        <button
          type="button"
          onClick={() => hasDept && chooseFilter('closed_dept')}
          disabled={!hasDept}
          title={hasDept ? '' : 'No department assigned to your profile.'}
          className={`${pillBase} ${
            !hasDept ? pillDisabled : filter === 'closed_dept' ? pillActive : pillIdle
          }`}
        >
          Closed · {deptLabel}
        </button>
        <button
          type="button"
          onClick={() => chooseFilter('uncategorized')}
          className={`${pillBase} ${filter === 'uncategorized' ? pillActive : pillIdle}`}
        >
          Uncategorised
        </button>
      </div>

      {isLoading && <p className="text-sm text-slate-500">Loading tickets…</p>}
      {error && <p className="alert-error">{(error as Error).message}</p>}
      {assignTicket.error && (
        <p className="alert-error">
          Could not save assignment: {(assignTicket.error as Error).message}
        </p>
      )}
      {updatePriority.error && (
        <p className="alert-error">
          Could not save priority: {(updatePriority.error as Error).message}
        </p>
      )}

      {data && data.length === 0 && (
        <div className="empty-state">
          {!dashboardView && filter === 'mine' ? (
            <>
              <p className="mb-4">You haven&apos;t submitted any tickets yet.</p>
              <Link to="/new" className="btn-primary">
                Submit your first ticket
              </Link>
            </>
          ) : (
            <p>
              {filter === 'uncategorized'
                ? 'No uncategorized tickets match this search.'
                : 'No tickets match this filter.'}
            </p>
          )}
        </div>
      )}

      {data && data.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table ticket-list-table">
            <thead>
              <tr>
                <SortHeading column="ref">Ticket ID</SortHeading>
                <SortHeading column="subject">Subject</SortHeading>
                <SortHeading column="submitter">Submitted by</SortHeading>
                <SortHeading column="assignee">Assigned to</SortHeading>
                <SortHeading column="priority">Priority</SortHeading>
                <SortHeading column="status">Status</SortHeading>
                <SortHeading column="opened">Opened</SortHeading>
                <SortHeading column="duration">Duration</SortHeading>
              </tr>
            </thead>
            <tbody>
              {sortedTickets.map((t) => {
                return (
                  <tr key={t.id}>
                    <td className="whitespace-nowrap">
                      <Link to={`/tickets/${t.id}`} className="ref-link">
                        {t.ref}
                      </Link>
                    </td>
                    <td className="min-w-40 max-w-72 break-words text-slate-700" title={t.subject}>
                      <Link to={`/tickets/${t.id}`} className="hover:underline">
                        {t.subject}
                      </Link>
                    </td>
                    <td className="max-w-44 break-words text-slate-700">
                      {nameFor(t.submitter_id, t.legacy_submitter_name)}
                    </td>
                    <td className="text-slate-700">
                      {isTicketStaff &&
                      (isAdmin ||
                        isManager ||
                        (role !== null && ROLE_DEPARTMENT[role] === t.department)) ? (
                        <select
                          aria-label={`Assigned to for ${t.ref}`}
                          value={t.assignee_id ?? ''}
                          disabled={
                            assignablePeopleQ.isLoading ||
                            !!assignablePeopleQ.error ||
                            (assignTicket.isPending && assignTicket.variables?.ticketId === t.id)
                          }
                          title={
                            assignablePeopleQ.error ? 'Unable to load department members.' : ''
                          }
                          onChange={(event) =>
                            assignTicket.mutate({
                              ticketId: t.id,
                              assigneeId: event.target.value || null,
                            })
                          }
                          className="field-select-sm min-w-36 py-1 text-xs disabled:opacity-60"
                        >
                          <option value="">Unassigned</option>
                          {t.assignee_id &&
                            !assigneesFor(t.department).some(
                              (person) => person.id === t.assignee_id,
                            ) && (
                              <option value={t.assignee_id}>
                                {nameFor(t.assignee_id, t.legacy_assignee_name)}
                              </option>
                            )}
                          {assigneesFor(t.department).map((person) => (
                            <option key={person.id} value={person.id}>
                              {person.full_name ?? person.email}
                            </option>
                          ))}
                        </select>
                      ) : (
                        nameFor(t.assignee_id, t.legacy_assignee_name)
                      )}
                    </td>
                    <td>
                      {canManageTicket(t) ? (
                        <select
                          aria-label={`Priority for ${t.ref}`}
                          value={t.priority}
                          disabled={
                            updatePriority.isPending && updatePriority.variables?.ticketId === t.id
                          }
                          onChange={(event) =>
                            updatePriority.mutate({
                              ticketId: t.id,
                              priority: event.target.value as TicketPriority,
                            })
                          }
                          className="field-select-sm min-w-24 py-1 text-xs disabled:opacity-60"
                        >
                          {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((priority) => (
                            <option key={priority} value={priority}>
                              {PRIORITY_LABEL[priority]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={PRIORITY_BADGE[t.priority]}>
                          {PRIORITY_LABEL[t.priority]}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={STATUS_BADGE[t.status]}>{STATUS_LABEL[t.status]}</span>
                    </td>
                    <td className="text-xs text-slate-500">
                      {new Date(t.created_at).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap text-xs text-slate-500">
                      {formatDuration(t.created_at, null)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {ticketResult &&
        (ticketResult.count === null ? (data?.length ?? 0) > 0 : ticketResult.count > 0) && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-600">
            <span>
              {ticketResult.count !== null
                ? `${ticketResult.count.toLocaleString()} tickets · page ${uncategorizedPage + 1} of ${Math.ceil(ticketResult.count / UNCATEGORIZED_PAGE_SIZE).toLocaleString()}`
                : `Showing ${uncategorizedPage * UNCATEGORIZED_PAGE_SIZE + 1}–${uncategorizedPage * UNCATEGORIZED_PAGE_SIZE + (data?.length ?? 0)} tickets${ticketResult.hasNext ? ' · more available' : ''}`}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setUncategorizedPage((page) => Math.max(0, page - 1))}
                disabled={uncategorizedPage === 0}
                className="btn-secondary px-3 py-1.5 disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setUncategorizedPage((page) => page + 1)}
                disabled={!ticketResult.hasNext}
                className="btn-secondary px-3 py-1.5 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>
        )}

      {(role === 'submitter' || isAvAdmin) && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-brand-navy">
            {isAvAdmin ? 'AV tickets' : 'My AV tickets'}
          </h2>
          <div className="mt-4 data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Setup</th>
                  <th>Location</th>
                  <th>Equipment</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(avRequestsQ.data ?? []).map((request) => (
                  <tr key={request.id}>
                    <td>{request.requested_date}</td>
                    <td>{request.setup_time.slice(0, 5)}</td>
                    <td>{request.location}</td>
                    <td>{request.equipment.join(', ') || 'None'}</td>
                    <td>
                      {request.requested_date >= new Date().toISOString().slice(0, 10) ? (
                        <Link
                          to={`/av-request?request=${request.id}`}
                          className="font-medium text-brand-navy hover:underline"
                        >
                          Edit
                        </Link>
                      ) : (
                        <span className="text-xs text-slate-500">Past</span>
                      )}
                    </td>
                  </tr>
                ))}
                {avRequestsQ.data?.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-slate-500">
                      No AV tickets yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}
