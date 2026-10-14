import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link } from 'react-router-dom';
import { DEPARTMENT_LABEL, STATUS_LABEL, TICKET_DEPARTMENTS, type Department, type Ticket } from '../lib/types';
import { supabase } from '../lib/supabase';

type DepartmentFilter = Department | 'all';
type TicketStatusFilter = 'all' | 'open' | 'closed' | 'pending';
type AssigneeFilter = 'all' | 'unassigned' | string;
type DateField = 'created_at' | 'closed_at' | 'resolved_at';
type ReportTicket = Pick<
  Ticket,
  | 'id'
  | 'ref'
  | 'department'
  | 'category_id'
  | 'subcategory_id'
  | 'subject'
  | 'description'
  | 'status'
  | 'priority'
  | 'submitter_id'
  | 'assignee_id'
  | 'created_at'
  | 'closed_at'
  | 'resolved_at'
  | 'time_spent_minutes'
  | 'legacy_submitter_name'
  | 'legacy_assignee_name'
  | 'legacy_subcategory'
>;

type ReportRow = {
  ticket: ReportTicket;
  category: string;
  subcategory: string;
  submitter: string;
  assignee: string;
  openedInPeriod: boolean;
  closedInPeriod: boolean;
};

type TimeReportRow = {
  ticket: Pick<ReportTicket, 'id' | 'ref' | 'subject' | 'assignee_id' | 'time_spent_minutes' | 'legacy_assignee_name'>;
  assignee: string;
};

type ReportData = {
  rows: ReportRow[];
  opened: number;
  openNow: number;
  closedTotal: number;
  closedInPeriod: number;
  timeRows: TimeReportRow[];
  pendingNow: number;
};

type TimelineDay = {
  day: string;
  open_count: number | null;
  closed_count: number;
  pending_count: number | null;
  tracking_since: string;
};

const REPORT_LABELS: Record<TicketStatusFilter, string> = {
  all: 'Department overview',
  open: 'Open tickets',
  closed: 'Closed tickets',
  pending: 'Pending / Needs Review',
};

const PAGE_SIZE = 500;
const REPORT_FIELDS =
  'id,ref,department,category_id,subcategory_id,subject,description,status,priority,submitter_id,assignee_id,created_at,closed_at,resolved_at,time_spent_minutes,legacy_submitter_name,legacy_assignee_name,legacy_subcategory';

function nextDate(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours === 0) return `${remainingMinutes} min`;
  if (remainingMinutes === 0) return `${hours} hr`;
  return `${hours} hr ${remainingMinutes} min`;
}

function csvCell(value: string | number | boolean | null): string {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function saveCsv(rows: ReportRow[], from: string, to: string, department: DepartmentFilter) {
  const headers = [
    'Reference', 'Subject', 'Department', 'Category', 'Subcategory', 'Status', 'Priority',
    'Created', 'Closed', 'Submitter', 'Assignee', 'Description', 'Time spent (minutes)', 'Opened in period', 'Closed in period',
  ];
  const lines = rows.map(({ ticket, category, subcategory, submitter, assignee, openedInPeriod, closedInPeriod }) => [
    ticket.ref,
    ticket.subject,
    DEPARTMENT_LABEL[ticket.department],
    category,
    subcategory,
    ticket.status,
    ticket.priority,
    ticket.created_at,
    ticket.closed_at ?? ticket.resolved_at,
    submitter,
    assignee,
    ticket.description,
    ticket.time_spent_minutes,
    openedInPeriod,
    closedInPeriod,
  ].map(csvCell).join(','));
  const blob = new Blob([`\ufeff${[headers.map(csvCell).join(','), ...lines].join('\r\n')}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `ticket-report-${department}-${from}-to-${to}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function DepartmentTicketReport({
  from,
  to,
  fixedDepartment,
}: {
  from: string;
  to: string;
  fixedDepartment: Department | null;
}) {
  const [department, setDepartment] = useState<DepartmentFilter>(fixedDepartment ?? 'all');
  const [statusFilter, setStatusFilter] = useState<TicketStatusFilter>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>('all');
  const [generated, setGenerated] = useState(false);

  const assigneesQ = useQuery({
    queryKey: ['department-report-assignees', department],
    enabled: !!supabase,
    queryFn: async () => {
      if (!supabase) throw new Error('Supabase not configured');
      const deptRoles: Record<Department, string> = {
        IT: 'it_tech',
        FAC: 'fac_tech',
        AV: 'av_admin',
        HS: 'hs_officer',
      };
      let query = supabase
        .from('profiles')
        .select('id,full_name,email,role,department')
        .order('full_name', { ascending: true });
      if (department === 'all') {
        query = query.in('role', ['it_tech', 'fac_tech', 'hs_officer', 'manager', 'admin']);
      } else {
        query = query.eq('department', department).in('role', [deptRoles[department], 'manager']);
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string;
        full_name: string | null;
        email: string;
        role: string;
        department: Department | null;
      }>;
    },
  });

  const reportQ = useQuery({
    queryKey: ['department-ticket-report', from, to, department, statusFilter, assigneeFilter],
    enabled: generated,
    queryFn: async (): Promise<ReportData> => {
      if (!supabase) throw new Error('Supabase not configured');
      const start = `${from}T00:00:00.000Z`;
      const end = `${nextDate(to)}T00:00:00.000Z`;

      async function ticketsInPeriod(field: DateField): Promise<ReportTicket[]> {
        const tickets: ReportTicket[] = [];
        for (let offset = 0; ; offset += PAGE_SIZE) {
          let query = supabase!
            .from('tickets')
            .select(REPORT_FIELDS)
            .gte(field, start)
            .lt(field, end)
            .order('created_at', { ascending: false }).order('id')
            .range(offset, offset + PAGE_SIZE - 1);
          if (department !== 'all') query = query.eq('department', department);
          if (assigneeFilter === 'unassigned') query = query.is('assignee_id', null);
          else if (assigneeFilter !== 'all') query = query.eq('assignee_id', assigneeFilter);
          const { data, error } = await query;
          if (error) throw error;
          const batch = (data ?? []) as unknown as ReportTicket[];
          tickets.push(...batch);
          if (batch.length < PAGE_SIZE) return tickets;
        }
      }

      async function ticketsWithTime(): Promise<ReportTicket[]> {
        const tickets: ReportTicket[] = [];
        for (let offset = 0; ; offset += PAGE_SIZE) {
          let query = supabase!
            .from('tickets')
            .select(REPORT_FIELDS)
            .gt('time_spent_minutes', 0)
            .order('time_spent_minutes', { ascending: false })
            .range(offset, offset + PAGE_SIZE - 1);
          if (department !== 'all') query = query.eq('department', department);
          if (assigneeFilter === 'unassigned') query = query.is('assignee_id', null);
          else if (assigneeFilter !== 'all') query = query.eq('assignee_id', assigneeFilter);
          const { data, error } = await query;
          if (error) throw error;
          const batch = (data ?? []) as unknown as ReportTicket[];
          tickets.push(...batch);
          if (batch.length < PAGE_SIZE) return tickets;
        }
      }

      async function outstandingTickets(): Promise<ReportTicket[]> {
        const tickets: ReportTicket[] = [];
        for (let offset = 0; ; offset += PAGE_SIZE) {
          let query = supabase!.from('tickets').select(REPORT_FIELDS)
            .in('status', ['open', 'in_progress', 'on_hold', 'awaiting_triage'])
            .lt('created_at', end)
            .order('created_at', { ascending: false }).order('id')
            .range(offset, offset + PAGE_SIZE - 1);
          if (department !== 'all') query = query.eq('department', department);
          if (assigneeFilter === 'unassigned') query = query.is('assignee_id', null);
          else if (assigneeFilter !== 'all') query = query.eq('assignee_id', assigneeFilter);
          const { data, error } = await query;
          if (error) throw error;
          const batch = (data ?? []) as unknown as ReportTicket[];
          tickets.push(...batch);
          if (batch.length < PAGE_SIZE) return tickets;
        }
      }

      const [openedTickets, closedTickets, resolvedTickets, timeTickets, outstanding] = await Promise.all([
        ticketsInPeriod('created_at'),
        ticketsInPeriod('closed_at'),
        ticketsInPeriod('resolved_at'),
        ticketsWithTime(),
        outstandingTickets(),
      ]);
      const openedIds = new Set(openedTickets.map((ticket) => ticket.id));
      const closedIds = new Set([...closedTickets, ...resolvedTickets].map((ticket) => ticket.id));
      const ticketsById = new Map<string, ReportTicket>();
      const completed = [...closedTickets, ...resolvedTickets].filter((ticket) => {
        const finished = ticket.closed_at ?? ticket.resolved_at;
        return finished !== null && finished >= start && finished < end;
      });
      const sourceTickets = statusFilter === 'closed' ? completed
        : statusFilter === 'open' ? outstanding.filter((ticket) => ['open', 'in_progress'].includes(ticket.status))
        : statusFilter === 'pending' ? outstanding.filter((ticket) => ['on_hold', 'awaiting_triage'].includes(ticket.status))
        : [...openedTickets, ...completed, ...outstanding];
      for (const ticket of sourceTickets) {
        ticketsById.set(ticket.id, ticket);
      }
      const tickets = Array.from(ticketsById.values()).sort((left, right) =>
        statusFilter === 'closed'
          ? (right.closed_at ?? right.resolved_at ?? '').localeCompare(left.closed_at ?? left.resolved_at ?? '')
          : right.created_at.localeCompare(left.created_at),
      );

      const categoryIds = Array.from(new Set(
        tickets.flatMap((ticket) => [ticket.category_id, ticket.subcategory_id])
          .filter((id): id is string => !!id),
      ));
      const profileIds = Array.from(new Set(
        [...tickets, ...timeTickets].flatMap((ticket) => [ticket.submitter_id, ticket.assignee_id])
          .filter((id): id is string => !!id),
      ));
      const [categoriesResult, profilesResult] = await Promise.all([
        categoryIds.length
          ? supabase.from('categories').select('id,name,parent_id').in('id', categoryIds)
          : Promise.resolve({ data: [], error: null }),
        profileIds.length
          ? supabase.from('profiles').select('id,full_name,email').in('id', profileIds)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (categoriesResult.error) throw categoriesResult.error;
      if (profilesResult.error) throw profilesResult.error;

      const categoryNames = new Map(
        ((categoriesResult.data ?? []) as Array<{ id: string; name: string; parent_id: string | null }>)
          .map((category) => [category.id, category.name]),
      );
      const people = new Map(
        ((profilesResult.data ?? []) as Array<{ id: string; full_name: string | null; email: string }>)
          .map((person) => [person.id, person.full_name ?? person.email]),
      );

      return {
        opened: openedIds.size,
        openNow: outstanding.filter((ticket) => ['open', 'in_progress'].includes(ticket.status)).length,
        pendingNow: outstanding.filter((ticket) => ['on_hold', 'awaiting_triage'].includes(ticket.status)).length,
        closedTotal: new Set(completed.map((ticket) => ticket.id)).size,
        closedInPeriod: new Set(completed.map((ticket) => ticket.id)).size,
        timeRows: timeTickets.map((ticket) => ({
          ticket,
          assignee: (ticket.assignee_id && people.get(ticket.assignee_id))
            ?? ticket.legacy_assignee_name
            ?? 'Unassigned',
        })),
        rows: tickets.map((ticket) => ({
          ticket,
          category: ticket.category_id
            ? categoryNames.get(ticket.category_id) ?? 'Category unavailable'
            : 'Uncategorised',
          subcategory: ticket.subcategory_id
            ? categoryNames.get(ticket.subcategory_id) ?? ticket.legacy_subcategory ?? ''
            : ticket.legacy_subcategory ?? '',
          submitter: (ticket.submitter_id && people.get(ticket.submitter_id))
            ?? ticket.legacy_submitter_name
            ?? '—',
          assignee: (ticket.assignee_id && people.get(ticket.assignee_id))
            ?? ticket.legacy_assignee_name
            ?? '—',
          openedInPeriod: openedIds.has(ticket.id),
          closedInPeriod: closedIds.has(ticket.id),
        })),
      };
    },
  });

  const timelineQ = useQuery({
    queryKey: ['department-report-timeline', from, to, department, assigneeFilter],
    enabled: generated && statusFilter === 'all',
    queryFn: async (): Promise<TimelineDay[]> => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data, error } = await supabase.rpc('department_report_timeline', {
        p_from: from,
        p_to: to,
        p_department: department === 'all' ? null : department,
        p_assignee: ['all', 'unassigned'].includes(assigneeFilter) ? null : assigneeFilter,
        p_unassigned: assigneeFilter === 'unassigned',
      });
      if (error) throw error;
      return (data ?? []) as TimelineDay[];
    },
  });

  const visibleRows = (reportQ.data?.rows ?? []).filter(({ ticket }) => {
    const matchesAssignee = assigneeFilter === 'all' ||
      (assigneeFilter === 'unassigned' ? !ticket.assignee_id : ticket.assignee_id === assigneeFilter);
    return matchesAssignee;
  });
  const visibleTimeRows = (reportQ.data?.timeRows ?? []).filter(({ ticket }) =>
    assigneeFilter === 'all' ||
    (assigneeFilter === 'unassigned' ? !ticket.assignee_id : ticket.assignee_id === assigneeFilter),
  );

  function printReport() {
    const cleanup = () => document.body.classList.remove('printing-report');
    document.body.classList.add('printing-report');
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
  }

  return (
    <section className="mt-8 report-print-area">
      <div className="page-header">
        <div>
          <h2 className="text-lg font-semibold text-brand-navy">{REPORT_LABELS[statusFilter]}</h2>
          <p className="text-sm text-slate-500">
            {department === 'all' ? 'All departments' : DEPARTMENT_LABEL[department]} · {from} through {to}
          </p>
          <p className="text-xs text-slate-500">
            {statusFilter === 'open' || statusFilter === 'pending'
              ? 'Current outstanding tickets created by the selected end date.'
              : 'Recorded completions and ticket activity for the selected dates.'}
          </p>
          {assigneeFilter !== 'all' && <p className="text-xs text-slate-500">Assigned to: {assigneeFilter === 'unassigned'
            ? 'Unassigned' : assigneesQ.data?.find((person) => person.id === assigneeFilter)?.full_name
              || assigneesQ.data?.find((person) => person.id === assigneeFilter)?.email}</p>}
        </div>
        <div className="report-no-print flex flex-wrap items-end gap-2">
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase text-slate-500">Report type</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as TicketStatusFilter)}
                className="field-select-sm"
              >
                <option value="all">Department overview</option>
                <option value="open">Open tickets</option>
                <option value="closed">Closed tickets</option>
                <option value="pending">Pending / Needs Review</option>
              </select>
            </label>
          {!fixedDepartment && (
            <div>
              <label htmlFor="report-department" className="mb-1 block text-[11px] font-semibold uppercase text-slate-500">
                Department
              </label>
              <select
                id="report-department"
                value={department}
                onChange={(event) => {
                  setDepartment(event.target.value as DepartmentFilter);
                  setAssigneeFilter('all');
                }}
                className="field-select-sm"
              >
                <option value="all">All departments</option>
                {TICKET_DEPARTMENTS.map((item) => (
                  <option key={item} value={item}>{DEPARTMENT_LABEL[item]}</option>
                ))}
              </select>
            </div>
          )}
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase text-slate-500">Assigned to</span>
              <select
                value={assigneeFilter}
                onChange={(event) => setAssigneeFilter(event.target.value)}
                className="field-select-sm"
              >
                <option value="all">All</option>
                <option value="unassigned">Unassigned</option>
                {(assigneesQ.data ?? []).map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.full_name || person.email}
                  </option>
                ))}
              </select>
            </label>
          <button
            type="button"
            onClick={() => {
              if (generated) {
                void reportQ.refetch();
                if (statusFilter === 'all') void timelineQ.refetch();
              } else setGenerated(true);
            }}
            disabled={reportQ.isFetching || (statusFilter === 'all' && timelineQ.isFetching)}
            className="btn-primary px-4 py-2"
          >
            {reportQ.isFetching ? 'Generating…' : 'Generate report'}
          </button>
          {reportQ.data && (
            <>
              <button
                type="button"
                onClick={() => saveCsv(visibleRows, from, to, department)}
                className="btn-secondary px-4 py-2"
              >
                Download CSV
              </button>
              <button type="button" onClick={printReport} disabled={reportQ.isFetching || (statusFilter === 'all' && timelineQ.isFetching)} className="btn-secondary inline-flex items-center gap-2 px-4 py-2">
                <Printer aria-hidden="true" size={16} />
                Print / Save PDF
              </button>
            </>
          )}
        </div>
      </div>

      {reportQ.error && <p className="mb-4 alert-error">{(reportQ.error as Error).message}</p>}
      {assigneesQ.error && <p className="mb-4 alert-error">Could not load department assignees.</p>}
      {reportQ.data && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-lg bg-slate-100 p-3">
              <div className="text-2xl font-semibold text-slate-900">{reportQ.data.openNow}</div>
              <div className="text-xs text-slate-600">Open now</div>
            </div>
            <div className="rounded-lg bg-sky-50 p-3">
              <div className="text-2xl font-semibold text-sky-800">{reportQ.data.pendingNow}</div>
              <div className="text-xs text-sky-700">Pending / Needs Review now</div>
            </div>
            <div className="rounded-lg bg-emerald-50 p-3">
              <div className="text-2xl font-semibold text-emerald-800">{reportQ.data.closedInPeriod}</div>
              <div className="text-xs text-emerald-700">Completed in period</div>
            </div>
            <div className="rounded-lg bg-amber-50 p-3">
              <div className="text-2xl font-semibold text-amber-800">{reportQ.data.opened}</div>
              <div className="text-xs text-amber-700">Opened in period</div>
            </div>
          </div>
          {statusFilter === 'all' && (
            <section className="report-timeline mb-6 border-y border-slate-200 py-5">
              <h3 className="text-base font-semibold text-brand-navy">Department timeline</h3>
              <p className="mb-3 text-xs text-slate-500">Open and Pending / Needs Review: daily outstanding balances. Closed: cumulative recorded completions in this period. Dates use UTC.</p>
              {timelineQ.isFetching && <p role="status" className="text-sm text-slate-500">Loading timeline...</p>}
              {timelineQ.error && <p role="alert" className="alert-error">Could not load timeline: {(timelineQ.error as Error).message}</p>}
              {timelineQ.data && timelineQ.data.length > 0 && (
                <>
                  <div className="h-80 w-full min-w-0" role="img" aria-label="Department ticket timeline: open tickets, cumulative closed tickets, and combined pending and needs review tickets by date">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={timelineQ.data} margin={{ top: 12, right: 20, bottom: 8, left: 0 }} accessibilityLayer>
                        <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="day" tickFormatter={(value: string) => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })} tick={{ fontSize: 11 }} minTickGap={25} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={45} />
                        <Tooltip labelFormatter={(value) => String(value)} />
                        <Legend wrapperStyle={{ fontSize: 12 }} />
                        <Line type="stepAfter" dataKey="open_count" name="Open" stroke="#0284c7" strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={false} />
                        <Line type="stepAfter" dataKey="closed_count" name="Closed (cumulative)" stroke="#059669" strokeWidth={2.5} dot={{ r: 3 }} isAnimationActive={false} />
                        <Line type="stepAfter" dataKey="pending_count" name="Pending / Needs Review" stroke="#d97706" strokeWidth={2.5} strokeDasharray="5 3" dot={{ r: 3 }} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <p className="mt-2 text-xs text-slate-500">Status balance tracking began {new Date(timelineQ.data[0]!.tracking_since).toLocaleDateString('en-GB', { timeZone: 'UTC' })}. Earlier open and pending balances are unavailable.</p>
                </>
              )}
              {timelineQ.data?.length === 0 && <p className="empty-state">No dates available for this timeline.</p>}
            </section>
          )}
          {visibleRows.length === 0 ? (
            <p className="empty-state">No tickets match this report.</p>
          ) : (
            <>
            <div className="data-table-wrap report-scroll">
              <table className="data-table min-w-[1100px] whitespace-nowrap">
                <thead>
                  <tr>
                    <th>Ref</th><th>Subject</th><th>Department</th><th>Category</th><th>Subcategory</th>
                    <th>Status</th><th>Priority</th><th>Opened</th><th>Closed</th><th>Submitted by</th>
                    <th>Assigned to</th><th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(({ ticket, category, subcategory, submitter, assignee }) => (
                    <tr key={ticket.id}>
                      <td className="font-mono"><Link to={`/tickets/${ticket.id}`} className="ref-link">{ticket.ref}</Link></td>
                      <td className="max-w-56 truncate" title={ticket.subject}>{ticket.subject}</td>
                      <td>{DEPARTMENT_LABEL[ticket.department]}</td>
                      <td>{category}</td>
                      <td>{subcategory || '—'}</td>
                      <td>{STATUS_LABEL[ticket.status]}</td>
                      <td>{ticket.priority}</td>
                      <td>{new Date(ticket.created_at).toLocaleString()}</td>
                      <td>{ticket.closed_at || ticket.resolved_at
                        ? new Date(ticket.closed_at ?? ticket.resolved_at!).toLocaleString()
                        : '—'}</td>
                      <td>{submitter}</td>
                      <td>{assignee}</td>
                      <td className="max-w-80 truncate" title={ticket.description}>{ticket.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="report-print-tickets">
              {visibleRows.map(({ ticket, category, subcategory, submitter, assignee }) => (
                <article key={ticket.id} className="report-print-ticket">
                  <h3><span>Ticket</span>{ticket.ref} | {ticket.subject}</h3>
                  <div className="report-print-fields">
                    <p><span>Department</span>{DEPARTMENT_LABEL[ticket.department]}</p>
                    <p><span>Category</span>{category}</p>
                    <p><span>Subcategory</span>{subcategory || '—'}</p>
                    <p><span>Status</span>{STATUS_LABEL[ticket.status]}</p>
                    <p><span>Priority</span>{ticket.priority}</p>
                    <p><span>Opened</span>{new Date(ticket.created_at).toLocaleString()}</p>
                    <p><span>Closed</span>{ticket.closed_at || ticket.resolved_at
                      ? new Date(ticket.closed_at ?? ticket.resolved_at!).toLocaleString()
                      : '—'}</p>
                    <p><span>Submitted by</span>{submitter}</p>
                    <p><span>Assigned to</span>{assignee}</p>
                    <p><span>Time spent</span>{formatMinutes(ticket.time_spent_minutes)}</p>
                  </div>
                  <p className="report-print-description"><span>Description</span>{ticket.description || '—'}</p>
                </article>
              ))}
            </div>
            </>
          )}
          <section className="mt-8">
            <div className="mb-3">
              <h3 className="text-base font-semibold text-brand-navy">Time spent by ticket</h3>
              <p className="text-xs text-slate-500">Lifetime totals, sorted from most time to least.</p>
            </div>
            {visibleTimeRows.length === 0 ? (
              <p className="empty-state">No ticket time has been recorded for this department.</p>
            ) : (
              <div className="data-table-wrap report-scroll report-time-table">
                <table className="data-table min-w-[640px]">
                  <thead>
                    <tr><th>Ticket</th><th>Subject</th><th>Assigned to</th><th>Total time spent</th></tr>
                  </thead>
                  <tbody>
                    {visibleTimeRows.map(({ ticket, assignee }) => (
                      <tr key={ticket.id}>
                        <td className="font-mono">{ticket.ref}</td>
                        <td>{ticket.subject}</td>
                        <td>{assignee}</td>
                        <td className="font-medium">{formatMinutes(ticket.time_spent_minutes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );
}