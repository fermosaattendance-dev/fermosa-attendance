import { COMPANY_WIDE_ROLES, ROLE_LABELS } from '@fermosa/shared';
import {
  BarChart3,
  Building2,
  CalendarCheck,
  CalendarDays,
  ClipboardCheck,
  Clock,
  Fingerprint,
  LayoutDashboard,
  LogOut,
  Menu,
  Network,
  ScrollText,
  Settings as SettingsIcon,
  Tablet,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';

type Access = 'all' | 'manager' | 'admin';
interface NavItem {
  to: string;
  end?: boolean;
  label: string;
  icon: LucideIcon;
  access: Access;
}

const NAV: NavItem[] = [
  { to: '/my', end: true, label: 'My time clock', icon: Fingerprint, access: 'all' },
  { to: '/my/leave', label: 'My leave', icon: CalendarCheck, access: 'all' },
  { to: '/', end: true, label: 'Dashboard', icon: LayoutDashboard, access: 'manager' },
  { to: '/employees', label: 'Employees', icon: Users, access: 'manager' },
  { to: '/punches', label: 'Punches', icon: Clock, access: 'manager' },
  { to: '/reviews', label: 'Reviews', icon: ClipboardCheck, access: 'manager' },
  { to: '/leave', label: 'Leave', icon: CalendarDays, access: 'manager' },
  { to: '/reports', label: 'Reports', icon: BarChart3, access: 'manager' },
  { to: '/kiosks', label: 'Kiosks', icon: Tablet, access: 'admin' },
  { to: '/branches', label: 'Branches', icon: Building2, access: 'admin' },
  { to: '/org', label: 'Departments', icon: Network, access: 'admin' },
  { to: '/audit', label: 'Audit log', icon: ScrollText, access: 'admin' },
  { to: '/settings', label: 'Settings', icon: SettingsIcon, access: 'admin' },
];

const navItemClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
    isActive
      ? 'bg-brand-50 font-semibold text-brand-700'
      : 'font-medium text-muted hover:bg-ground hover:text-ink'
  }`;

export function Layout() {
  const { profile, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  if (!profile) return null;

  const isAdmin = COMPANY_WIDE_ROLES.includes(profile.role);
  const isBranchManager = profile.role === 'branch_manager';
  const canSee = (a: Access) =>
    a === 'all' || (a === 'admin' && isAdmin) || (a === 'manager' && (isAdmin || isBranchManager));
  const items = NAV.filter((i) => canSee(i.access));

  const initials = profile.full_name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  // Gold brand block at the top of the sidebar.
  const brand = (
    <div className="fm-bar relative flex h-16 shrink-0 items-center gap-3 px-4">
      <div className="fm-bar-shine pointer-events-none absolute inset-0" />
      <span className="relative grid h-10 w-10 place-items-center rounded-xl bg-white shadow-[0_2px_6px_rgba(120,84,0,0.28)]">
        <img src="/fermosa-mark.jpg" alt="Fermosa" className="h-8 w-8 rounded-lg object-contain" />
      </span>
      <div className="relative leading-none">
        <div className="text-lg font-bold text-white [text-shadow:0_1px_1px_rgba(140,96,0,0.35)]">
          Fermosa
        </div>
        <div className="mt-1 text-[8px] font-semibold uppercase tracking-[0.3em] text-white/90">
          Skin Care Clinic
        </div>
      </div>
    </div>
  );

  const nav = (
    <nav className="flex-1 space-y-1 overflow-y-auto p-3">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={navItemClass}
          onClick={() => setMenuOpen(false)}
        >
          {({ isActive }) => (
            <>
              <item.icon
                className={`h-[18px] w-[18px] shrink-0 ${isActive ? 'text-brand-600' : ''}`}
                strokeWidth={2}
              />
              {item.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );

  const userFooter = (
    <div className="shrink-0 border-t border-line p-3">
      <div className="flex items-center gap-3 px-1 py-2">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-100 text-[13px] font-bold text-brand-700">
          {initials}
        </span>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold text-ink">{profile.full_name}</div>
          <div className="text-xs text-muted">{ROLE_LABELS[profile.role]}</div>
        </div>
      </div>
      <button
        onClick={signOut}
        className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium text-muted transition hover:bg-ground hover:text-ink"
      >
        <LogOut className="h-4 w-4" />
        Sign out
      </button>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar (left) */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-white lg:flex">
        {brand}
        {nav}
        {userFooter}
      </aside>

      {/* Mobile drawer */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-white shadow-xl">
            {brand}
            {nav}
            {userFooter}
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar (brand + hamburger) */}
        <header className="fm-bar relative flex h-14 items-center justify-between px-4 lg:hidden">
          <div className="fm-bar-shine pointer-events-none absolute inset-0" />
          <div className="relative flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-white shadow-[0_2px_6px_rgba(120,84,0,0.28)]">
              <img src="/fermosa-mark.jpg" alt="Fermosa" className="h-7 w-7 rounded object-contain" />
            </span>
            <span className="text-lg font-bold text-white [text-shadow:0_1px_1px_rgba(140,96,0,0.35)]">
              Fermosa
            </span>
          </div>
          <button
            onClick={() => setMenuOpen(true)}
            aria-label="Menu"
            className="relative grid h-10 w-10 place-items-center rounded-lg border border-on-gold/25 bg-white/25 text-on-gold"
          >
            <Menu className="h-5 w-5" />
          </button>
        </header>

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
