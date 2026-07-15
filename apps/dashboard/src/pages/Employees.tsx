import { COMPANY_WIDE_ROLES, ROLE_LABELS, type Role, type EmploymentStatus } from '@fermosa/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

export const STATUS_LABELS: Record<EmploymentStatus, string> = {
  active: 'Active',
  probationary: 'Probationary',
  on_leave: 'On Leave',
  resigned: 'Resigned',
  terminated: 'Terminated',
};

interface EmployeeRow {
  id: string;
  full_name: string;
  employee_code: string;
  role: Role;
  employment_status: EmploymentStatus;
  branch: { id: string; name: string } | null;
  position: { name: string } | null;
}

export function Employees() {
  const { profile } = useAuth();
  const [rows, setRows] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [branchFilter, setBranchFilter] = useState('all');

  const isAdmin = profile ? COMPANY_WIDE_ROLES.includes(profile.role) : false;

  useEffect(() => {
    supabase
      .from('profiles')
      .select(
        'id, full_name, employee_code, role, employment_status, branch:branches(id, name), position:positions(name)',
      )
      .order('full_name')
      .then(({ data }) => {
        setRows((data as unknown as EmployeeRow[]) ?? []);
        setLoading(false);
      });
  }, []);

  const branches = useMemo(() => {
    const map = new Map<string, string>();
    rows.forEach((r) => r.branch && map.set(r.branch.id, r.branch.name));
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const visible = rows.filter((r) => {
    const q = search.trim().toLowerCase();
    const matchesSearch =
      !q ||
      r.full_name.toLowerCase().includes(q) ||
      r.employee_code.toLowerCase().includes(q);
    const matchesBranch = branchFilter === 'all' || r.branch?.id === branchFilter;
    return matchesSearch && matchesBranch;
  });

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Employees"
        crumb="Employees"
        subtitle={isAdmin ? 'Everyone in the company.' : 'Employees in your branch.'}
        right={
          isAdmin && (
            <Link to="/employees/new" className="btn-primary">
              New employee
            </Link>
          )
        }
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or code…"
          className="input w-64"
        />
        <select
          value={branchFilter}
          onChange={(e) => setBranchFilter(e.target.value)}
          className="input max-w-[220px]"
        >
          <option value="all">All branches</option>
          {branches.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="fm-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Code</th>
              <th>Role</th>
              <th>Branch</th>
              <th>Position</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="text-center text-muted">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && visible.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-muted">
                  No employees found
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr key={r.id}>
                <td className="font-semibold text-ink">
                  {isAdmin ? (
                    <Link to={`/employees/${r.id}`} className="text-brand-700 hover:underline">
                      {r.full_name}
                    </Link>
                  ) : (
                    r.full_name
                  )}
                </td>
                <td className="tnum text-muted">{r.employee_code}</td>
                <td className="text-muted">{ROLE_LABELS[r.role]}</td>
                <td className="text-muted">{r.branch?.name ?? '—'}</td>
                <td className="text-muted">{r.position?.name ?? '—'}</td>
                <td>
                  <span
                    className={
                      r.employment_status === 'active' || r.employment_status === 'probationary'
                        ? 'pill bg-green-100 text-green-700'
                        : 'pill bg-gray-100 text-gray-500'
                    }
                  >
                    {STATUS_LABELS[r.employment_status]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
