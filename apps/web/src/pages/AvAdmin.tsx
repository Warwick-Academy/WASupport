import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import AvRecurringAdmin from '../components/AvRecurringAdmin';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

type AvRequestRecord = {
  id: string;
  requester_name: string;
  requester_email: string;
  requested_date: string;
  setup_time: string;
  equipment: string[];
  music_request: string;
  location: string;
  details: string | null;
  links: string[];
  calendar_status: string;
  created_at: string;
};

type AvRequestFile = {
  id: string;
  original_name: string;
  storage_path: string;
  size_bytes: number;
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function displayDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

export default function AvAdmin() {
  const { isAdmin, isAvAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('request');
  const detailsDialog = useRef<HTMLDialogElement>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [requesterSearch, setRequesterSearch] = useState('');
  const [requesterEmail, setRequesterEmail] = useState('');
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const requests = useQuery({
    queryKey: ['av-admin-requests'],
    queryFn: async (): Promise<AvRequestRecord[]> => {
      if (!supabase) throw new Error('Supabase not configured');
      const records: AvRequestRecord[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await supabase
          .from('av_requests')
          .select('id,requester_name,requester_email,requested_date,setup_time,equipment,music_request,location,details,links,calendar_status,created_at')
          .order('requested_date', { ascending: false })
          .order('setup_time', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id')
          .range(offset, offset + 499);
        if (error) throw error;
        const batch = (data ?? []) as AvRequestRecord[];
        records.push(...batch);
        if (batch.length < 500) return records;
      }
    },
  });

  const requesters = Array.from(new Map(
    (requests.data ?? []).map((request) => [
      request.requester_email.toLowerCase(),
      { email: request.requester_email.toLowerCase(), name: request.requester_name },
    ]),
  ).values()).sort((left, right) => left.name.localeCompare(right.name));
  const search = requesterSearch.trim().toLowerCase();
  const filteredRequests = (requests.data ?? []).filter((request) =>
    (!requesterEmail || request.requester_email.toLowerCase() === requesterEmail) &&
    (!search || request.requester_name.toLowerCase().includes(search) || request.requester_email.toLowerCase().includes(search)),
  );

  const files = useQuery({
    queryKey: ['av-admin-request-files', selectedId],
    enabled: Boolean(selectedId),
    queryFn: async (): Promise<Array<AvRequestFile & { url: string }>> => {
      if (!supabase || !selectedId) return [];
      const client = supabase;
      const { data, error } = await client
        .from('av_request_files')
        .select('id,original_name,storage_path,size_bytes')
        .eq('request_id', selectedId);
      if (error) throw error;
      return Promise.all((data as AvRequestFile[]).map(async (file) => {
        const { data: signed, error: signedError } = await client.storage
          .from('av-request-files')
          .createSignedUrl(file.storage_path, 3600);
        if (signedError) throw signedError;
        return { ...file, url: signed.signedUrl };
      }));
    },
  });

  const selected = requests.data?.find((request) => request.id === selectedId) ?? null;
  useEffect(() => {
    const dialog = detailsDialog.current;
    if (selected && dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, [selected]);

  useEffect(() => { setDeleteError(null); }, [selectedId]);

  function closeDetails() {
    const next = new URLSearchParams(searchParams);
    next.delete('request');
    setSearchParams(next);
  }

  async function deleteRequest(id: string) {
    if (!supabase || isDeleting || !window.confirm('Delete this AV request?')) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const { data, error } = await supabase.from('av_requests').delete().eq('id', id).select('id');
      if (error) throw error;
      if (data?.length !== 1) throw new Error('The request was not deleted. Your account may not have permission, or the request no longer exists.');
      queryClient.setQueryData<AvRequestRecord[]>(['av-admin-requests'], (current) => current?.filter((request) => request.id !== id));
      if (selectedId === id) closeDetails();
      await queryClient.invalidateQueries({ queryKey: ['av-admin-requests'] });
      await queryClient.invalidateQueries({ queryKey: ['my-av-request-summaries'] });
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Could not delete this AV request.');
    } finally {
      setIsDeleting(false);
    }
  }
  const byDate = new Map<string, AvRequestRecord[]>();
  for (const request of requests.data ?? []) {
    const current = byDate.get(request.requested_date) ?? [];
    current.push(request);
    byDate.set(request.requested_date, current);
  }

  const firstWeekday = month.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const day = index - firstWeekday + 1;
    return day > 0 && day <= daysInMonth ? new Date(month.getFullYear(), month.getMonth(), day) : null;
  });

  return (
    <section>
      <div className="page-header">
        <div>
          <h1 className="page-title">Audio Visual Admin</h1>
          <p className="page-subtitle">Review submitted AV requests and scheduled setup dates.</p>
        </div>
        <Link to="/av-request" className="btn-primary">
          <Plus aria-hidden="true" size={16} />
          New AV ticket
        </Link>
      </div>

      {requests.error && <p className="alert-error">{requests.error instanceof Error ? requests.error.message : 'Could not load AV requests.'}</p>}
      {requests.isLoading && <p className="text-sm text-slate-500">Loading AV requests...</p>}

      {selected && (
        <dialog
          ref={detailsDialog}
          aria-labelledby="av-details-title"
          onCancel={(event) => { event.preventDefault(); closeDetails(); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); closeDetails(); }
          }}
          className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-3xl overflow-y-auto rounded-lg border-0 bg-white p-6 text-slate-900 shadow-xl backdrop:bg-slate-950/50"
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase text-slate-500">Request details</p>
              <h2 id="av-details-title" className="mt-1 text-xl font-semibold text-brand-navy">{selected.location}</h2>
              <p className="mt-1 text-sm text-slate-600">{displayDate(selected.requested_date)} at {selected.setup_time.slice(0, 5)}</p>
            </div>
            <div className="flex items-center gap-4">
              <Link to={`/av-request?request=${selected.id}`} className="text-sm font-medium text-brand-navy hover:underline">Edit</Link>
              <button type="button" disabled={isDeleting} onClick={() => void deleteRequest(selected.id)} className="text-sm font-medium text-rose-700 hover:underline disabled:opacity-50">{isDeleting ? 'Deleting...' : 'Delete'}</button>
              <button type="button" onClick={closeDetails} title="Close details" aria-label="Close details" className="rounded-md p-2 text-brand-navy hover:bg-slate-100"><X size={20} aria-hidden="true" /></button>
            </div>
          </div>
          {deleteError && <p role="alert" className="mt-4 alert-error">{deleteError}</p>}
          <dl className="mt-6 grid gap-5 md:grid-cols-2">
            <div><dt className="field-label">Requester</dt><dd>{selected.requester_name}<br /><a className="text-sm text-brand-navy hover:underline" href={`mailto:${selected.requester_email}`}>{selected.requester_email}</a></dd></div>
            <div><dt className="field-label">Date requested for:</dt><dd>{displayDate(selected.requested_date)} at {selected.setup_time.slice(0, 5)}</dd></div>
            <div><dt className="field-label">Equipment</dt><dd>{selected.equipment.join(', ') || 'None selected'}</dd></div>
            <div><dt className="field-label">Music</dt><dd>{selected.music_request}</dd></div>
            <div className="md:col-span-2"><dt className="field-label">Details</dt><dd className="whitespace-pre-wrap">{selected.details || 'No additional details.'}</dd></div>
          </dl>
          {selected.links.length > 0 && <div className="mt-5"><p className="field-label">Links</p><ul className="space-y-1">{selected.links.map((link) => <li key={link}><a href={link} target="_blank" rel="noreferrer" className="break-all text-sm text-brand-navy hover:underline">{link}</a></li>)}</ul></div>}
          {files.data && files.data.length > 0 && <div className="mt-5"><p className="field-label">Files</p><ul className="space-y-1">{files.data.map((file) => <li key={file.id}><a href={file.url} target="_blank" rel="noreferrer" className="text-sm text-brand-navy hover:underline">{file.original_name} ({(file.size_bytes / 1024 / 1024).toFixed(1)} MB)</a></li>)}</ul></div>}
          {files.isLoading && <p className="mt-5 text-sm text-slate-500">Loading files...</p>}
          {files.error && <p role="alert" className="mt-5 alert-error">Could not load request files.</p>}
        </dialog>
      )}

      <section>
        <h2 className="text-lg font-semibold text-brand-navy">AV ticket requests</h2>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="field-label">Search requester</span>
            <input
              type="search"
              value={requesterSearch}
              onChange={(event) => setRequesterSearch(event.target.value)}
              placeholder="Name or email"
              className="field-sm"
            />
          </label>
          <label className="block min-w-0">
            <span className="field-label">Requester</span>
            <select
              value={requesterEmail}
              onChange={(event) => setRequesterEmail(event.target.value)}
              className="field-select-sm max-w-full"
            >
              <option value="">All requesters</option>
              {requesters.map((requester) => (
                <option key={requester.email} value={requester.email}>
                  {requester.name} ({requester.email})
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="mt-4 data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Date requested for:</th><th>Requester</th><th>Location</th><th>Equipment</th><th></th></tr></thead>
            <tbody>
              {filteredRequests.map((request) => (
                <tr key={request.id}>
                  <td className="whitespace-nowrap">{displayDate(request.requested_date)}<br /><span className="text-xs text-slate-500">{request.setup_time.slice(0, 5)}</span></td>
                  <td>{request.requester_name}</td>
                  <td>{request.location}</td>
                  <td>{request.equipment.join(', ') || 'None'}</td>
                  <td><Link to={`/admin/av?request=${request.id}`} className="font-medium text-brand-navy hover:underline">View</Link></td>
                </tr>
              ))}
              {requests.data && filteredRequests.length === 0 && <tr><td colSpan={5} className="text-center text-slate-500">{requests.data.length === 0 ? 'No AV requests yet.' : 'No AV requests match this requester.'}</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-brand-navy">Calendar</h2>
          <div className="flex items-center gap-3">
            <button type="button" title="Previous month" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="h-9 w-9 rounded-md border border-slate-300 bg-white text-xl text-brand-navy hover:bg-slate-50">‹</button>
            <p className="min-w-36 text-center font-semibold text-slate-800">{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</p>
            <button type="button" title="Next month" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="h-9 w-9 rounded-md border border-slate-300 bg-white text-xl text-brand-navy hover:bg-slate-50">›</button>
          </div>
        </div>
        <div className="mt-4 overflow-x-auto rounded-md border border-slate-200 bg-white">
          <div className="grid min-w-[760px] grid-cols-7 border-b border-slate-200 bg-slate-50">{WEEKDAYS.map((day) => <div key={day} className="px-3 py-2 text-xs font-semibold uppercase text-slate-500">{day}</div>)}</div>
          <div className="grid min-w-[760px] grid-cols-7">
            {cells.map((date, index) => {
              const key = date ? dateKey(date) : `empty-${index}`;
              const dayRequests = date ? byDate.get(key) ?? [] : [];
              return (
                <div key={key} className="min-h-28 border-b border-r border-slate-200 p-2 last:border-r-0">
                  {date && <><p className="text-xs font-semibold text-slate-600">{date.getDate()}</p><div className="mt-2 space-y-1">{dayRequests.map((request) => <Link key={request.id} to={`/admin/av?request=${request.id}`} className="block rounded bg-blue-50 px-2 py-1 text-xs font-medium text-brand-navy hover:bg-blue-100"><span className="block truncate">{request.setup_time.slice(0, 5)} {request.location}</span><span className="block truncate font-normal text-slate-600">{request.requester_name}</span></Link>)}</div></>}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {(isAdmin || isAvAdmin) && <AvRecurringAdmin />}
    </section>
  );
}