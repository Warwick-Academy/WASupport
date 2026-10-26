import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';

type Tile = {
  to: string;
  title: string;
  description: string;
  icon: JSX.Element;
};

const TILES: Tile[] = [
  {
    to: '/new',
    title: 'Submit a ticket',
    description: 'Report a problem to IT, Facilities, or Health & Safety.',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        className="h-10 w-10"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-3-3v6M4 6h16v12H4z" />
      </svg>
    ),
  },
  {
    to: '/kb',
    title: 'Knowledge base',
    description: 'Browse how-to articles and answers to common questions.',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        className="h-10 w-10"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 5a2 2 0 012-2h12v18H6a2 2 0 01-2-2V5zM8 7h8M8 11h8M8 15h5"
        />
      </svg>
    ),
  },
  {
    to: '/videos',
    title: 'Video library',
    description: 'Watch short how-to videos for software, hardware, and apps.',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        className="h-10 w-10"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5z"
        />
        <path strokeLinecap="round" strokeLinejoin="round" d="M10 9l5 3-5 3V9z" />
      </svg>
    ),
  },
  {
    to: '/av-request',
    title: 'AV Request',
    description: 'Request audio/visual support for an event or class.',
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        className="h-10 w-10"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 7h16v10H4zM8 17l-2 4m10-4 2 4M9 11h6m-3-4V3"
        />
      </svg>
    ),
  },
];

const EVENT_SETUP_TILE: Tile = {
  to: '/event-setup',
  title: 'Event Setup',
  description: 'Request room setup for an event, exam, or assembly.',
  icon: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      className="h-10 w-10"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7 3v3m10-3v3M4 9h16M5 5h14a1 1 0 011 1v13H4V6a1 1 0 011-1zm3 8h3m-3 3h6"
      />
    </svg>
  ),
};

export default function Home() {
  const { profile, user, isTicketStaff, profileLoading } = useAuth();
  const greeting = profile?.full_name?.split(' ')[0] ?? '';
  const tiles = profile?.show_event_setup ? [...TILES, EVENT_SETUP_TILE] : TILES;

  if (user && profileLoading) {
    return <div className="p-6 text-sm text-slate-500">Loading your dashboard…</div>;
  }
  return (
    <section className="mx-auto max-w-5xl">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold text-slate-900">
          Welcome{greeting ? `, ${greeting}` : ''}
        </h1>
        <p className="mt-1 text-sm text-slate-600">What would you like to do today?</p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            className="group flex flex-col items-start gap-3 rounded-xl border border-slate-200 bg-white p-6 shadow-sm transition hover:-translate-y-0.5 hover:border-[#1a2744] hover:shadow-md"
          >
            <div className="rounded-lg bg-slate-100 p-3 text-[#1a2744] group-hover:bg-[#1a2744] group-hover:text-white">
              {t.icon}
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{t.title}</h2>
              <p className="mt-1 text-sm text-slate-600">{t.description}</p>
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-10">
        <h3 className="text-sm font-medium uppercase tracking-wide text-slate-500">
          {isTicketStaff ? 'Staff shortcuts' : 'Shortcuts'}
        </h3>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            to="/tickets?view=mine"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            My tickets
          </Link>
          {isTicketStaff && (
            <>
              <Link
                to="/tickets"
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                Tickets
              </Link>
              <Link
                to="/dashboard"
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                Dashboard
              </Link>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
