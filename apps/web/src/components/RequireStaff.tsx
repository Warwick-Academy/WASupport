import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function RequireStaff() {
  const { user, isTicketStaff, loading } = useAuth();
  if (loading) return <div className="p-6 text-slate-500">Loading…</div>;
  if (!user) return <Navigate to="/signin" replace />;
  if (!isTicketStaff) return <Navigate to="/" replace />;
  return <Outlet />;
}
