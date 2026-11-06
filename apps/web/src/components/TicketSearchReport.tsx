import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { DEPARTMENT_LABEL, PRIORITY_LABEL, STATUS_LABEL, TICKET_DEPARTMENTS, type TicketDepartment } from '../lib/types';
import { downloadCsv, printReport } from '../lib/reportExport';
import { loadReportCategories, loadTicketSearchReport, searchReportCsvRows, type SearchReportFilters } from '../lib/ticketSearchReport';

const PREVIEW_SIZE = 50;

export default function TicketSearchReport({ fixedDepartment }: { fixedDepartment: TicketDepartment | null }) {
  const { user } = useAuth();
  const [department, setDepartment] = useState<SearchReportFilters['department']>(fixedDepartment ?? 'all');
  const [categoryId, setCategoryId] = useState('');
  const [keywords, setKeywords] = useState('');
  const [submitted, setSubmitted] = useState<SearchReportFilters | null>(null);
  const [page, setPage] = useState(0);
  const categoriesQ = useQuery({
    queryKey: ['ticket-search-report-categories', user?.id],
    queryFn: ({ signal }) => {
      if (!supabase) throw new Error('Supabase not configured');
      return loadReportCategories(supabase, signal);
    },
  });
  const reportQ = useQuery({
    queryKey: ['ticket-search-report', user?.id, submitted],
    enabled: submitted !== null && categoriesQ.isSuccess,
    queryFn: ({ signal }) => {
      if (!supabase || !submitted || !categoriesQ.data) throw new Error('Report is not ready');
      return loadTicketSearchReport(supabase, submitted, categoriesQ.data, signal);
    },
  });
  const categories = (categoriesQ.data ?? []).filter((category) =>
    TICKET_DEPARTMENTS.some((value) => value === category.department) &&
    (department === 'all' || category.department === department),
  );
  const categoryNames = new Map((categoriesQ.data ?? []).map((category) => [category.id, category.name]));
  const rows = reportQ.data ?? [];
  const visiblePage = Math.min(page, Math.max(0, Math.ceil(rows.length / PREVIEW_SIZE) - 1));
  const closed = rows.filter(({ ticket }) => ticket.status === 'closed' || ticket.status === 'resolved').length;
  const ready = reportQ.isSuccess && !reportQ.isFetching;
  const changed = submitted && (submitted.department !== department || submitted.categoryId !== categoryId ||
    submitted.keywords !== keywords.trim());

  return (
    <section className="space-y-4 report-print-area">
      <form className="report-no-print space-y-4" onSubmit={(event) => {
        event.preventDefault();
        const filters = { department, categoryId, keywords: keywords.trim() };
        setPage(0);
        if (submitted && JSON.stringify(submitted) === JSON.stringify(filters)) void reportQ.refetch();
        else setSubmitted(filters);
      }}>
        <div className="flex flex-wrap items-end gap-3">
          <label>
            <span className="field-label">Department</span>
            <select className="field-select-sm" value={department} disabled={!!fixedDepartment}
              onChange={(event) => {
                setDepartment(event.target.value as SearchReportFilters['department']);
                setCategoryId('');
              }}>
              {!fixedDepartment && <option value="all">All departments</option>}
              {TICKET_DEPARTMENTS.map((value) => <option key={value} value={value}>{DEPARTMENT_LABEL[value]}</option>)}
            </select>
          </label>
          <label>
            <span className="field-label">Category / subcategory</span>
            <select className="field-select-sm max-w-full" value={categoryId}
              disabled={!categoriesQ.isSuccess} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">All categories</option>
              {categories.map((category) => <option key={category.id} value={category.id}>
                {department === 'all' ? `${DEPARTMENT_LABEL[category.department]} / ` : ''}
                {category.parent_id ? `${categoryNames.get(category.parent_id) ?? 'Category'} / ` : ''}
                {category.name}{!category.is_active ? ' (retired)' : ''}
              </option>)}
            </select>
          </label>
          <label className="min-w-60 flex-1">
            <span className="field-label">Keywords</span>
            <input className="field-sm w-full" value={keywords} onChange={(event) => setKeywords(event.target.value)}
              placeholder="e.g. roof leak" aria-describedby="ticket-search-help" />
          </label>
          <button type="submit" className="btn-primary px-4 py-2"
            disabled={reportQ.isFetching || !categoriesQ.isSuccess}>
            {reportQ.isFetching ? 'Generating...' : 'Generate report'}
          </button>
        </div>
        <p id="ticket-search-help" className="text-sm text-slate-500">
          All history, all statuses. Every keyword must appear in the reference, subject, or description.
          Category and keyword filters are combined. Leave both blank for all tickets in the department.
        </p>
        {changed && <p className="alert-info">Filters changed. Generate the report to update the results and exports.</p>}
      </form>

      {categoriesQ.isPending && <p role="status">Loading categories...</p>}
      {categoriesQ.error && <div role="alert" className="alert-error">
        Could not load categories: {categoriesQ.error.message}{' '}
        <button type="button" className="underline" onClick={() => void categoriesQ.refetch()}>Retry</button>
      </div>}
      {reportQ.isFetching && <p role="status" className="report-no-print">Loading all matching tickets...</p>}
      {reportQ.error && <p role="alert" className="alert-error">Could not generate report: {reportQ.error.message}</p>}

      {ready && submitted && <>
        <header className="space-y-2">
          <h2 className="text-lg font-semibold text-brand-navy">Ticket search report</h2>
          <p className="text-sm">
            {submitted.department === 'all' ? 'All departments' : DEPARTMENT_LABEL[submitted.department]}
            {' | '}Category: {categoryNames.get(submitted.categoryId) ?? 'All categories'}
            {' | '}Keywords: {submitted.keywords || 'None'}
            {' | '}All history
          </p>
          <p className="text-sm">{rows.length} {rows.length === 1 ? 'ticket' : 'tickets'}: {rows.length - closed} open (including in progress, on hold, and needs review), {closed} resolved / closed.</p>
          <div className="report-no-print flex flex-wrap gap-2">
            <button type="button" className="btn-ghost px-4 py-2" disabled={!rows.length}
              onClick={() => downloadCsv(`ticket-search-${submitted.department}.csv`, searchReportCsvRows(rows))}>
              Download CSV
            </button>
            <button type="button" className="btn-ghost px-4 py-2" disabled={!rows.length} onClick={printReport}>
              <Printer size={16} aria-hidden="true" />Print / Save PDF
            </button>
          </div>
        </header>
        {!rows.length ? <p className="empty-state">No tickets match these filters.</p> : <>
          <div className="report-no-print space-y-3">
            <p className="text-sm text-slate-500">Showing {visiblePage * PREVIEW_SIZE + 1}-{Math.min((visiblePage + 1) * PREVIEW_SIZE, rows.length)} of {rows.length}. CSV and PDF include every result.</p>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Reference</th><th>Subject</th><th>Department</th><th>Category</th><th>Status</th><th>Created</th></tr></thead>
                <tbody>{rows.slice(visiblePage * PREVIEW_SIZE, (visiblePage + 1) * PREVIEW_SIZE).map(({ ticket, category, subcategory }) =>
                  <tr key={ticket.id}>
                    <td><Link className="ref-link" to={`/tickets/${ticket.id}`}>{ticket.ref}</Link></td>
                    <td>{ticket.subject}</td><td>{DEPARTMENT_LABEL[ticket.department]}</td>
                    <td>{[category, subcategory].filter(Boolean).join(' / ')}</td>
                    <td>{STATUS_LABEL[ticket.status]}</td><td>{new Date(ticket.created_at).toLocaleDateString()}</td>
                  </tr>,
                )}</tbody>
              </table>
            </div>
            <div className="flex gap-2">
              <button type="button" className="btn-primary px-3 py-2" disabled={visiblePage === 0} onClick={() => setPage(visiblePage - 1)}>Previous</button>
              <button type="button" className="btn-primary px-3 py-2" disabled={(visiblePage + 1) * PREVIEW_SIZE >= rows.length} onClick={() => setPage(visiblePage + 1)}>Next</button>
            </div>
          </div>
          <div className="report-print-tickets">
            {rows.map(({ ticket, category, subcategory, submitter, assignee }) =>
              <article key={ticket.id} className="report-print-ticket">
                <h3>{ticket.ref} - {ticket.subject}</h3>
                <div className="report-print-fields">
                  <p><span>Department:</span>{DEPARTMENT_LABEL[ticket.department]}</p>
                  <p><span>Category:</span>{[category, subcategory].filter(Boolean).join(' / ')}</p>
                  <p><span>Status:</span>{STATUS_LABEL[ticket.status]}</p>
                  <p><span>Priority:</span>{PRIORITY_LABEL[ticket.priority]}</p>
                  <p><span>Submitter:</span>{submitter}</p><p><span>Assignee:</span>{assignee}</p>
                  <p><span>Created:</span>{new Date(ticket.created_at).toLocaleString()}</p>
                  <p><span>Resolved:</span>{ticket.resolved_at ? new Date(ticket.resolved_at).toLocaleString() : '-'}</p>
                  <p><span>Closed:</span>{ticket.closed_at ? new Date(ticket.closed_at).toLocaleString() : '-'}</p>
                  <p><span>Time spent:</span>{ticket.time_spent_minutes} minutes</p>
                  {ticket.legacy_ref && <p><span>Legacy reference:</span>{ticket.legacy_ref}</p>}
                </div>
                <p className="report-print-description whitespace-pre-wrap"><span>Description:</span>{ticket.description}</p>
              </article>,
            )}
          </div>
        </>}
      </>}
    </section>
  );
}
