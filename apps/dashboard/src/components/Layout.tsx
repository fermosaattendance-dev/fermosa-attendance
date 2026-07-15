import { COMPANY_WIDE_ROLES, ROLE_LABELS } from '@fermosa/shared';
import {
  BarChart3,
  Building2,
  CalendarDays,
  ClipboardCheck,
  Clock,
  LayoutDashboard,
  Menu,
  Network,
  ScrollText,
  Settings as SettingsIcon,
  Tablet,
  Users,
  X,
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
  { to: '/', end: true, label: 'Dashboard', icon: LayoutDashboard, access: 'all' },
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

const desktopTab = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 whitespace-nowrap border-b-[2.5px] px-3.5 py-3 text-sm transition ${
    isActive
      ? 'border-brand-500 font-semibold text-ink'
      : 'border-transparent font-medium text-muted hover:text-ink'
  }`;

const mobileItem = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition ${
    isActive ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink hover:bg-ground'
  }`;

export function Layout() {
  const { profile, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  if (!profile) return null;

  const isAdmin = COMPANY_WIDE_ROLES.includes(profile.role);
  const isBranchManager = profile.role === 'branch_manager';
  const canSee = (a: Access) => a === 'all' || (a === 'admin' && isAdmin) || (a === 'manager' && (isAdmin || isBranchManager));
  const items = NAV.filter((i) => canSee(i.access));

  const initials = profile.full_name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30">
        {/* Gold brand bar */}
        <div className="fm-bar relative">
          <div className="fm-bar-shine pointer-events-none absolute inset-0" />
          <div className="relative mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-white shadow-[0_2px_6px_rgba(120,84,0,0.28)]">
                <img src="/fermosa-mark.jpg" alt="Fermosa" className="h-8 w-8 rounded-lg object-contain" />
              </span>
              <div className="leading-none">
                <div className="text-xl font-bold text-white [text-shadow:0_1px_1px_rgba(140,96,0,0.35)]">
                  Fermosa
                </div>
                <div className="mt-1 text-[8px] font-semibold uppercase tracking-[0.34em] text-white/90">
                  Skin Care Clinic
                </div>
              </div>
            </div>

            {/* Desktop user chip */}
            <div className="hidden items-center gap-3 lg:flex">
              <div className="text-right leading-tight">
                <div className="text-sm font-semibold text-on-gold">{profile.full_name}</div>
                <div className="text-[11px] text-on-gold/70">{ROLE_LABELS[profile.role]}</div>
              </div>
              <span className="grid h-9 w-9 place-items-center rounded-full bg-on-gold text-[13px] font-bold text-brand-300">
                {initials}
              </span>
              <button
                onClick={signOut}
                className="rounded-lg border border-on-gold/25 bg-white/25 px-3 py-1.5 text-xs font-semibold text-on-gold transition hover:bg-white/40"
              >
                Sign out
              </button>
            </div>

            {/* Mobile menu toggle */}
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="Menu"
              className="grid h-10 w-10 place-items-center rounded-lg border border-on-gold/25 bg-white/25 text-on-gold lg:hidden"
            >
              {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Desktop tab nav */}
        <nav className="hidden border-b border-line bg-white lg:block">
          <div className="mx-auto max-w-7xl overflow-x-auto px-3">
            <div className="flex min-w-max gap-1">
              {items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={desktopTab}>
                  {({ isActive }) => (
                    <>
                      <item.icon
                        className={`h-4 w-4 ${isActive ? 'text-brand-600' : ''}`}
                        strokeWidth={2}
                      />
                      {item.label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          </div>
        </nav>

        {/* Mobile drawer */}
        {menuOpen && (
          <nav className="border-b border-line bg-white lg:hidden">
            <div className="space-y-1 px-3 py-3">
              {items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={mobileItem}
                  onClick={() => setMenuOpen(false)}
                >
                  <item.icon className="h-4 w-4" strokeWidth={2} />
                  {item.label}
                </NavLink>
              ))}
              <div className="mt-2 flex items-center justify-between border-t border-line px-1 pt-3">
                <div className="leading-tight">
                  <div className="text-sm font-semibold text-ink">{profile.full_name}</div>
                  <div className="text-xs text-muted">{ROLE_LABELS[profile.role]}</div>
                </div>
                <button onClick={signOut} className="btn">
                  Sign out
                </button>
              </div>
            </div>
          </nav>
        )}
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}
