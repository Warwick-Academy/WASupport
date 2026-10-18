import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { ROLE_LABEL } from '../lib/types';

export default function AppShell() {
  const { user, role, isStaff, isAdmin, isAvAdmin, isManager, signOut } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    await signOut();
    navigate('/signin');
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    [
      'text-sm transition-colors duration-200',
      isActive ? 'text-white font-medium' : 'text-slate-300 hover:text-white',
    ].join(' ');

  return (
    <div className="min-h-screen">
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
            {isStaff && (
              <NavLink to="/queue" className={linkClass}>
                Queue
              </NavLink>
            )}
            {isStaff && (
              <NavLink to="/dashboard" className={linkClass}>
                Dashboard
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
            {isManager && (
              <NavLink to="/admin/locations" className={linkClass}>
                Locations
              </NavLink>
            )}
            {isManager && (
              <NavLink to="/admin/notifications" className={linkClass}>
                Notifications
              </NavLink>
            )}
            {isAdmin && (
              <NavLink to="/admin/import" className={linkClass}>
                Import
              </NavLink>
            )}
            <NavLink to="/status" className={linkClass}>
              Status
            </NavLink>

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

      <main className="mx-auto max-w-6xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
