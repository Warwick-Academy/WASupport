import { useState } from 'react';
import DepartmentTicketReport from '../components/DepartmentTicketReport';
import { useAuth } from '../lib/auth';
import {
  DEPARTMENT_LABEL,
  ROLE_DEPARTMENT,
  TICKET_DEPARTMENTS,
  type Department,
  type TicketDepartment,
  type UserRole,
} from '../lib/types';

function localDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function memberDepartment(
  role: UserRole | null,
  department: Department | null,
): TicketDepartment | null {
  const value = role === 'manager' ? department : role ? ROLE_DEPARTMENT[role] ?? null : null;
  return value && TICKET_DEPARTMENTS.includes(value as TicketDepartment)
    ? value as TicketDepartment
    : null;
}

export default function DepartmentReports() {
  const { role, profile, isAdmin } = useAuth();
  const [to, setTo] = useState(() => localDate(new Date()));
  const [from, setFrom] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 29);
    return localDate(date);
  });
  const fixedDepartment = memberDepartment(role, profile?.department ?? null);

  if (!isAdmin && !fixedDepartment) {
    return <p className="alert-warn">Department members, managers, and admins only.</p>;
  }

  const today = localDate(new Date());
  const dateError = !from || !to ? 'Choose a start and end date.'
    : from > to ? 'Choose a start date on or before the end date.'
    : to > today ? 'Choose an end date no later than today.'
    : Date.parse(to) - Date.parse(from) > 365 * 86400000 ? 'Choose a range of up to 366 days.' : null;

  function selectPeriod(period: 'week' | 'month' | 'this-month') {
    const start = new Date();
    if (period === 'this-month') start.setDate(1);
    else start.setDate(start.getDate() - (period === 'week' ? 6 : 29));
    setFrom(localDate(start));
    setTo(today);
  }

  return (
    <section className="space-y-6">
      <header>
        <h1 className="page-title">Department reports</h1>
        <p className="page-subtitle">
          {fixedDepartment
            ? `${DEPARTMENT_LABEL[fixedDepartment]} ticket activity and recorded time.`
            : 'Ticket activity and recorded time across departments.'}
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3 border-y border-slate-200 py-4">
        <label className="block">
          <span className="field-label">From</span>
          <input type="date" value={from} max={to || today} onChange={(event) => setFrom(event.target.value)} className="field" />
        </label>
        <label className="block">
          <span className="field-label">To</span>
          <input type="date" value={to} min={from} max={today} onChange={(event) => setTo(event.target.value)} className="field" />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => selectPeriod('week')} className="btn-ghost px-3 py-2">Last 7 days</button>
          <button type="button" onClick={() => selectPeriod('month')} className="btn-ghost px-3 py-2">Last 30 days</button>
          <button type="button" onClick={() => selectPeriod('this-month')} className="btn-ghost px-3 py-2">This month</button>
        </div>
        {dateError && <p role="alert" className="alert-error">{dateError}</p>}
      </div>

      {!dateError && (
        <DepartmentTicketReport
          key={isAdmin ? 'admin' : fixedDepartment}
          from={from}
          to={to}
          fixedDepartment={isAdmin ? null : fixedDepartment}
        />
      )}
    </section>
  );
}