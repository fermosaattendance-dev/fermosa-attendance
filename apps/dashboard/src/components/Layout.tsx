import { COMPANY_WIDE_ROLES, ROLE_LABELS } from '@fermosa/shared';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `block rounded-lg px-3 py-2 text-sm ${
    isActive
      ? 'bg-brand-600 font-medium text-white'
      : 'text-gray-700 hover:bg-gray-100'
  }`;

export function Layout() {
  const { profile, signOut } = useAuth();
  if (!profile) return null;

  const isAdmin = COMPANY_WIDE_ROLES.includes(profile.role);
  const isBranchManager = profile.role === 'branch_manager';

  return (
    <div className="flex min-h-screen bg-gray-50">
      <aside className="flex w-56 flex-col border-r border-gray-200 bg-white">
        <div className="border-b border-gray-200 px-4 py-4">
          <h1 className="text-base font-semibold text-gray-900">Fermosa Attendance</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {profile.full_name} · {ROLE_LABELS[profile.role]}
          </p>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          <NavLink to="/" end className={linkClass}>
            Overview
          </NavLink>
          {(isAdmin || isBranchManager) && (
            <>
              <NavLink to="/employees" className={linkClass}>
                Employees
              </NavLink>
              <NavLink to="/punches" className={linkClass}>
                Punches
              </NavLink>
              <NavLink to="/reviews" className={linkClass}>
                Reviews
              </NavLink>
            </>
          )}
          {isAdmin && (
            <>
              <NavLink to="/kiosks" className={linkClass}>
                Kiosks
              </NavLink>
              <NavLink to="/branches" className={linkClass}>
                Branches
              </NavLink>
              <NavLink to="/org" className={linkClass}>
                Departments &amp; Positions
              </NavLink>
              <NavLink to="/settings" className={linkClass}>
                Settings
              </NavLink>
            </>
          )}
        </nav>
        <div className="border-t border-gray-200 p-3">
          <button
            onClick={signOut}
            className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
          >
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-x-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
