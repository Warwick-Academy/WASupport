import { useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL } from '../lib/types';
import { ROLE_DEPARTMENT, TICKET_DEPARTMENTS, type TicketDepartment } from '../lib/types';

export default function AppShell() {
  const {
    user,
    profile,
    role,
    isTicketStaff,
    isAdmin,
    isAvAdmin,
    isManager,
    impersonation,
    stopImpersonation,
    signOut,
  } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [impersonationError, setImpersonationError] = useState<string | null>(null);

  async function handleSignOut() {
    await signOut();
    navigate('/signin');
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    [
      'text-sm transition-colors duration-200',
      isActive ? 'text-white font-medium' : 'text-slate-300 hover:text-white',
    ].join(' ');
  const roleDepartment = role ? ROLE_DEPARTMENT[role] : null;
  const canViewReports = isAdmin ||
    (roleDepartment !== null && roleDepartment !== undefined && TICKET_DEPARTMENTS.includes(roleDepartment as TicketDepartment)) ||
    (role === 'manager' && !!profile?.department && TICKET_DEPARTMENTS.includes(profile.department as TicketDepartment));

  return (
    <div className="min-h-screen">
      {impersonation && (
        <div className="flex flex-wrap items-center justify-between gap-3 bg-amber-100 px-6 py-2 text-sm text-amber-950">
          <p>
            Emulating <strong>{impersonation.targetEmail}</strong>
            {impersonation.targetDepartment ? ` · ${impersonation.targetDepartment}` : ''}
            {' '}· Reason: {impersonation.reason}
          </p>
          <div className="flex items-center gap-3">
            {impersonationError && <span role="alert" className="text-rose-700">{impersonationError}</span>}
            <button
              type="button"
              onClick={async () => {
                setImpersonationError(null);
                try {
                  await stopImpersonation();
                  navigate('/admin/users', { replace: true });
                } catch (error) {
                  setImpersonationError(error instanceof Error ? error.message : 'Could not end emulation.');
                }
              }}
              className="rounded border border-amber-800 px-3 py-1 text-xs font-semibold text-amber-950 hover:bg-amber-200"
            >
              End emulation
            </button>
          </div>
        </div>
      )}
      <header
        className="bg-[#1a2744] text-white"
        style={{ borderBottom: '1px solid #2a3a5c' }}
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
          <Link
            to="/"
            className="text-lg font-semibold text-white"
            style={{ letterSpacing: '0.5px' }}
          >
            WA Support Center
          </Link>

          <nav className="flex flex-wrap items-center gap-6">
            <NavLink to="/" end className={linkClass}>
              Home
            </NavLink>
            <NavLink to="/tickets" className={linkClass}>
              Tickets
            </NavLink>
            <NavLink to="/kb" className={linkClass}>
              Knowledge base
            </NavLink>
            <NavLink to="/videos" className={linkClass}>
              Videos
            </NavLink>
            {isTicketStaff && (
              <NavLink to="/dashboard" className={linkClass}>
                Dashboard
              </NavLink>
            )}
            {canViewReports && (
              <NavLink to="/reports" className={linkClass}>
                Reports
              </NavLink>
            )}
            {(isAvAdmin || isAdmin) && (
              <NavLink to="/admin/av" className={linkClass}>
                AV Admin
              </NavLink>
            )}
            {(role === 'fac_tech' || isManager) && (
              <NavLink to="/event-setup" className={linkClass}>
                Event Setup
              </NavLink>
            )}
            {isAdmin && (
              <NavLink to="/admin/users" className={linkClass}>
                Users
              </NavLink>
            )}
            {isManager && (
              <NavLink to="/admin/categories" className={linkClass}>
                Categories
              </NavLink>
            )}
            {isAdmin && (
              <NavLink to="/admin/locations" className={linkClass}>
                Locations
              </NavLink>
            )}
            {isManager && isAdmin && (
              <NavLink to="/admin/notifications" className={linkClass}>
                Email log
              </NavLink>
            )}
            {isAdmin && (
              <NavLink to="/admin/import" className={linkClass}>
                Import
              </NavLink>
            )}
            {isAdmin && (
              <NavLink to="/admin/submitter-matches" className={linkClass}>
                Ticket matches
              </NavLink>
            )}
            {(!isManager || isAdmin) && (
              <NavLink to="/status" className={linkClass}>
                Status
              </NavLink>
            )}

            <NavLink to="/new" className="btn-pill">
              + New ticket
            </NavLink>

            <Link
              to="/profile"
              className="ml-2 hidden flex-col items-end leading-tight md:flex group"
              title="View your profile"
            >
              <span className="text-xs text-slate-300 group-hover:text-white">{user?.email}</span>
              {role && (
                <span className="text-[11px] text-slate-400 group-hover:text-slate-200">
                  {ROLE_LABEL[role]}
                </span>
              )}
            </Link>

            <button
              onClick={handleSignOut}
              className="rounded-md border border-white/20 px-3 py-1.5 text-xs text-slate-200 transition-colors duration-200 hover:bg-white/10 hover:text-white"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <main className={`mx-auto ${pathname === '/tickets' && isTicketStaff ? 'max-w-[1600px]' : 'max-w-6xl'} px-6 py-10`}>
        <Outlet />
      </main>
    </div>
  );
}
