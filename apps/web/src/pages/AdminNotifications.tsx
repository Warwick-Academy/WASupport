import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';

type NotificationEvent = 'ticket.created' | 'ticket.reply' | 'ticket.status_changed' | 'ticket.assigned' | 'ticket.routed_to_manager' | 'ticket.sla_approaching' | 'ticket.sla_overdue';
type NotificationStatus = 'queued' | 'processing' | 'sent' | 'delivered' | 'bounced' | 'deferred' | 'skipped' | 'error';

interface NotificationRow {
  id: string;
  ticket_id: string | null;
  event: NotificationEvent;
  recipients: string[];
  status: NotificationStatus;
  error: string | null;
  created_at: string;
  ticket_ref: string | null;
  subject: string | null;
  attempts: number;
  total_count: number;
  outbox_id: string | null;
}

interface TicketRefRow {
  id: string;
  ref: string;
  subject: string;
}

const EVENT_LABEL: Record<NotificationEvent, string> = {
  'ticket.created': 'Created',
  'ticket.reply': 'Reply',
  'ticket.status_changed': 'Status changed',
  'ticket.assigned': 'Assigned',
  'ticket.routed_to_manager': 'Routed to manager',
  'ticket.sla_approaching': 'SLA approaching',
  'ticket.sla_overdue': 'SLA overdue',
};

const STATUS_BADGE: Record<NotificationStatus, string> = {
  queued: 'bg-amber-100 text-amber-800',
  processing: 'bg-sky-100 text-sky-800',
  sent: 'bg-emerald-100 text-emerald-800',
  delivered: 'bg-emerald-100 text-emerald-800',
  bounced: 'bg-rose-100 text-rose-800',
  deferred: 'bg-amber-100 text-amber-800',
  skipped: 'bg-slate-100 text-slate-700',
  error: 'bg-rose-100 text-rose-800',
};

export default function AdminNotifications() {
  const { isAdmin, role } = useAuth();
  const canView = isAdmin;
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: async (id: string) => {
      if (!supabase) throw new Error('Supabase not configured');
      const { error } = await supabase.rpc('retry_ticket_email', { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-notifications'] }),
  });

  const [statusFilter, setStatusFilter] = useState<'' | NotificationStatus>('');
  const [eventFilter, setEventFilter] = useState<'' | NotificationEvent>('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(0);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['admin-notifications', statusFilter, eventFilter, search, from, to, page],
    enabled: canView,
    queryFn: async (): Promise<{ rows: NotificationRow[]; tickets: Record<string, TicketRefRow>; count: number }> => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data: rows, error: rowsErr } = await supabase.rpc('search_email_log', {
        p_search: search.trim(), p_status: statusFilter, p_event: eventFilter,
        p_from: from || null, p_to: to || null, p_offset: page * 50,
      });
      if (rowsErr) throw rowsErr;
      const list = (rows ?? []) as NotificationRow[];

      const tickets: Record<string, TicketRefRow> = {};
      for (const row of list) {
        if (row.ticket_id) tickets[row.ticket_id] = { id: row.ticket_id, ref: row.ticket_ref || row.ticket_id, subject: row.subject || '' };
      }
      return { rows: list, tickets, count: Number(list[0]?.total_count ?? 0) };
    },
  });

  if (!canView) {
    return <p className="alert-warn">Admins only. Your role: {role ?? 'unknown'}.</p>;
  }

  return (
    <section>
      <div className="page-header">
        <div>
          <h1 className="page-title">Email log</h1>
          <p className="text-sm italic text-slate-500">
            Ticket email history. Accepted means SendGrid accepted the email; Delivered and Bounced require signed delivery callbacks.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label><span className="field-label">Search</span><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} placeholder="Ticket, subject, recipient" className="field-sm" /></label>
          <label><span className="field-label">From</span><input type="date" value={from} max={to || undefined} onChange={(event) => { setFrom(event.target.value); setPage(0); }} className="field-sm" /></label>
          <label><span className="field-label">To</span><input type="date" value={to} min={from || undefined} onChange={(event) => { setTo(event.target.value); setPage(0); }} className="field-sm" /></label>
          <select
            aria-label="Email status"
            value={statusFilter}
            onChange={(e) => { setStatusFilter(e.target.value as typeof statusFilter); setPage(0); }}
            className="field-select-sm"
          >
            <option value="">All statuses</option>
            {Object.keys(STATUS_BADGE).map((status) => <option key={status} value={status}>{status === 'sent' ? 'Accepted' : status.charAt(0).toUpperCase() + status.slice(1)}</option>)}
          </select>
          <select
            aria-label="Email event"
            value={eventFilter}
            onChange={(e) => { setEventFilter(e.target.value as typeof eventFilter); setPage(0); }}
            className="field-select-sm"
          >
            <option value="">All events</option>
            {Object.entries(EVENT_LABEL).map(([event, label]) => <option key={event} value={event}>{label}</option>)}
          </select>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <p className="mb-4 alert-error">{(error as Error).message}</p>}
      {retry.error && <p className="mb-4 alert-error">{retry.error.message}</p>}
      {isLoading && <p className="text-sm text-slate-500">Loading notifications…</p>}

      {data && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Ticket</th>
                <th>Event</th>
                <th>Recipients</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Error</th>
                <th>Retry</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-6 text-center text-sm text-slate-500">
                    No notifications match the current filters.
                  </td>
                </tr>
              )}
              {data.rows.map((r) => {
                const t = r.ticket_id ? data.tickets[r.ticket_id] : null;
                return (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap text-xs text-slate-500">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap">
                      {t ? (
                        <a
                          href={`/tickets/${t.id}`}
                          className="font-mono text-xs text-sky-700 hover:underline"
                          title={t.subject}
                        >
                          {t.ref}
                        </a>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-sm text-slate-700">
                      {EVENT_LABEL[r.event] || r.event}
                    </td>
                    <td className="text-xs text-slate-600">
                      {r.recipients.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        r.recipients.join(', ')
                      )}
                    </td>
                    <td>
                      <span
                        className={`inline-block rounded px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE[r.status]}`}
                      >
                        {r.status === 'sent' ? 'accepted' : r.status}
                      </span>
                    </td>
                    <td className="text-xs text-slate-600">{r.attempts}</td>
                    <td className="max-w-xs text-xs text-rose-700">
                      {r.error ? (
                        <span title={r.error} className="line-clamp-2 break-all">
                          {r.error}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td>{r.status === 'error' && r.outbox_id && <button type="button" title="Retry failed email" aria-label="Retry failed email" disabled={retry.isPending} onClick={() => retry.mutate(r.outbox_id!)} className="rounded border border-slate-300 p-2 text-brand-navy disabled:opacity-50"><RotateCcw size={16} aria-hidden="true" /></button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && <div className="mt-4 flex items-center justify-between gap-3 text-sm text-slate-600">
        <span>{data.count.toLocaleString()} emails · Page {page + 1} of {Math.max(1, Math.ceil(data.count / 50))}</span>
        <div className="flex gap-2">
          <button type="button" disabled={page === 0 || isFetching} onClick={() => setPage((value) => value - 1)} className="btn-ghost px-3 py-2 disabled:opacity-50">Previous</button>
          <button type="button" disabled={(page + 1) * 50 >= data.count || isFetching} onClick={() => setPage((value) => value + 1)} className="btn-ghost px-3 py-2 disabled:opacity-50">Next</button>
        </div>
      </div>}
    </section>
  );
}
