import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';

const LOCATIONS = ['PPMH', 'Lower Primary Quad', 'Upper Primary Quad', 'PPMH Quad', 'Old Quad', 'Field', 'Other'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

type RecurringEvent = {
  id: string;
  title: string;
  contact_name: string;
  contact_email: string;
  weekday: number;
  start_date: string;
  end_date: string | null;
  setup_time: string;
  location: string;
  is_active: boolean;
  calendar_event_id: string | null;
};

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export default function AvRecurringAdmin() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [weekday, setWeekday] = useState('3');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [setupTime, setSetupTime] = useState('');
  const [location, setLocation] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const schedules = useQuery({
    queryKey: ['av-recurring-events'],
    queryFn: async (): Promise<RecurringEvent[]> => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data, error } = await supabase
        .from('av_recurring_events')
        .select('id,title,contact_name,contact_email,weekday,start_date,end_date,setup_time,location,is_active,calendar_event_id')
        .order('start_date', { ascending: true });
      if (error) throw error;
      return data as RecurringEvent[];
    },
  });

  async function syncCalendar(id: string, action: 'create' | 'update') {
    if (!supabase) throw new Error('Supabase not configured');
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const providerToken = data.session?.provider_token;
    if (!token || !providerToken) {
      throw new Error('Calendar authorization is missing. Sign out and sign in with Microsoft again.');
    }
    const response = await fetch('/api/av-calendar', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-ms-provider-token': providerToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'recurring', id, action }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(body.error || 'Calendar creation failed');
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!supabase || !user) return;
    setError(null);
    setMessage(null);
    if (!title.trim() || !contactName.trim() || !/^\S+@\S+\.\S+$/.test(contactEmail)) {
      setError('Event title, contact name, and a valid email are required.');
      return;
    }
    if (!startDate || !setupTime || !location) {
      setError('Start date, setup time, and location are required.');
      return;
    }
    if (endDate && endDate < startDate) {
      setError('End date must be after the start date.');
      return;
    }
    if (new Date(`${startDate}T12:00:00`).getDay() !== Number(weekday)) {
      setError(`The start date must be a ${WEEKDAYS[Number(weekday)]}.`);
      return;
    }

    setSubmitting(true);
    try {
      const values = {
        title: title.trim(),
        contact_name: contactName.trim(),
        contact_email: contactEmail.trim().toLowerCase(),
        weekday: Number(weekday),
        start_date: startDate,
        end_date: endDate || null,
        setup_time: setupTime,
        location,
      };
      let scheduleId: string;
      let shouldUpdateCalendar = false;
      if (editingId) {
        const { data, error: updateError } = await supabase
          .from('av_recurring_events')
          .update(values)
          .eq('id', editingId)
          .select('id,calendar_event_id')
          .maybeSingle();
        if (updateError) throw updateError;
        if (!data) {
          throw new Error(
            'The recurring schedule was not updated. It may no longer exist or your account may not have permission.',
          );
        }
        scheduleId = data.id;
        shouldUpdateCalendar = Boolean(data.calendar_event_id);
      } else {
        const { data, error: insertError } = await supabase
          .from('av_recurring_events')
          .insert({
            created_by: user.id,
            ...values,
          })
          .select('id')
          .single();
        if (insertError) throw insertError;
        scheduleId = data.id;
      }
      await queryClient.invalidateQueries({ queryKey: ['av-recurring-events'] });
      try {
        await syncCalendar(scheduleId, shouldUpdateCalendar ? 'update' : 'create');
        setMessage(
          editingId
            ? 'Recurring schedule updated and Microsoft calendar event synchronized.'
            : 'Recurring schedule created and added to Microsoft calendar.',
        );
      } catch (calendarError) {
        setMessage(
          editingId ? 'Recurring schedule updated.' : 'Recurring reminder schedule created.',
        );
        setError(
          calendarError instanceof Error
            ? calendarError.message
            : 'Microsoft calendar synchronization failed.',
        );
      }
      setEditingId(null);
      setTitle('');
      setContactName('');
      setContactEmail('');
      setStartDate('');
      setEndDate('');
      setSetupTime('');
      setLocation('');
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : editingId
            ? 'Could not update recurring schedule.'
            : 'Could not create recurring schedule.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  function editSchedule(schedule: RecurringEvent) {
    setEditingId(schedule.id);
    setTitle(schedule.title);
    setContactName(schedule.contact_name);
    setContactEmail(schedule.contact_email);
    setWeekday(String(schedule.weekday));
    setStartDate(schedule.start_date);
    setEndDate(schedule.end_date ?? '');
    setSetupTime(schedule.setup_time.slice(0, 5));
    setLocation(schedule.location);
    setError(null);
    setMessage(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setTitle('');
    setContactName('');
    setContactEmail('');
    setWeekday('3');
    setStartDate('');
    setEndDate('');
    setSetupTime('');
    setLocation('');
    setError(null);
    setMessage(null);
  }

  return (
    <section className="mt-10 border-t border-slate-200 pt-8">
      <h2 className="text-lg font-semibold text-brand-navy">Recurring AV requests</h2>
      <p className="mt-1 text-sm text-slate-600">Contacts receive an email two days before each occurrence.</p>

      {schedules.error && <p className="mt-4 alert-error">{schedules.error instanceof Error ? schedules.error.message : 'Could not load schedules.'}</p>}
      {schedules.data && schedules.data.length > 0 && (
        <div className="mt-5 data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Event</th><th>Contact</th><th>Schedule</th><th>Location</th><th>Actions</th></tr></thead>
            <tbody>
              {schedules.data.map((schedule) => (
                <tr key={schedule.id}>
                  <td className="font-medium text-slate-800">{schedule.title}</td>
                  <td>{schedule.contact_name}<br /><span className="text-xs text-slate-500">{schedule.contact_email}</span></td>
                  <td>{WEEKDAYS[schedule.weekday]} at {schedule.setup_time.slice(0, 5)}<br /><span className="text-xs text-slate-500">{schedule.start_date} to {schedule.end_date || 'ongoing'}</span></td>
                  <td>{schedule.location}</td>
                  <td>
                    <button
                      type="button"
                      disabled={submitting}
                      onClick={() => editSchedule(schedule)}
                      className="btn-secondary px-3 py-1.5 text-sm disabled:opacity-50"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {message && <p className="mt-5 alert-success">{message}</p>}
      {error && <p className="mt-5 alert-error">{error}</p>}
      <h3 className="mt-5 text-sm font-semibold text-slate-800">
        {editingId ? 'Edit recurring event' : 'Create recurring event'}
      </h3>
      <form onSubmit={submit} className="mt-3 grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2"><label className="field-label">Event title</label><input required value={title} onChange={(event) => setTitle(event.target.value)} className="field" placeholder="Weekly assembly" /></div>
        <div><label className="field-label">Contact name</label><input required value={contactName} onChange={(event) => setContactName(event.target.value)} className="field" /></div>
        <div><label className="field-label">Contact email</label><input required type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} className="field" /></div>
        <div><label className="field-label">Repeats every</label><select value={weekday} onChange={(event) => setWeekday(event.target.value)} className="field-select">{WEEKDAYS.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></div>
        <div><label className="field-label">Set up by</label><input required type="time" value={setupTime} onChange={(event) => setSetupTime(event.target.value)} className="field" /></div>
        <div><label className="field-label">Start date</label><input required type="date" min={editingId ? undefined : localDate()} value={startDate} onChange={(event) => setStartDate(event.target.value)} className="field" /></div>
        <div><label className="field-label">End date (optional)</label><input type="date" min={startDate || localDate()} value={endDate} onChange={(event) => setEndDate(event.target.value)} className="field" /></div>
        <div className="md:col-span-2"><label className="field-label">Location</label><select required value={location} onChange={(event) => setLocation(event.target.value)} className="field-select"><option value="">Select a location</option>{LOCATIONS.map((item) => <option key={item}>{item}</option>)}</select></div>
        <div className="md:col-span-2 flex gap-2">
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting
              ? editingId
                ? 'Saving...'
                : 'Creating...'
              : editingId
                ? 'Save changes'
                : 'Create recurring event'}
          </button>
          {editingId && <button type="button" onClick={cancelEdit} className="btn-secondary">Cancel</button>}
        </div>
      </form>
    </section>
  );
}