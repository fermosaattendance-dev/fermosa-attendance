import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

interface Row {
  id: string;
  name: string;
}

function OrgList({ table, title, hint }: { table: 'departments' | 'positions'; title: string; hint: string }) {
  const { profile } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    supabase.from(table).select('id, name').order('name')
      .then(({ data }) => setRows((data as Row[]) ?? []));
  }, [table]);

  useEffect(reload, [reload]);

  const add = async () => {
    setError(null);
    const name = newName.trim();
    if (!name) return;
    const { error: err } = await supabase
      .from(table)
      .insert({ name, company_id: profile!.company_id });
    if (err) {
      setError(err.message);
      return;
    }
    setNewName('');
    reload();
  };

  const rename = async (row: Row) => {
    const name = window.prompt(`Rename "${row.name}" to:`, row.name)?.trim();
    if (!name || name === row.name) return;
    const { error: err } = await supabase.from(table).update({ name }).eq('id', row.id);
    if (err) setError(err.message);
    else reload();
  };

  const remove = async (row: Row) => {
    if (!window.confirm(`Delete "${row.name}"? Employees assigned to it keep working; the assignment is cleared.`)) return;
    const { error: err } = await supabase.from(table).delete().eq('id', row.id);
    if (err) setError(err.message);
    else reload();
  };

  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-xs text-muted">{hint}</p>

      <div className="mt-3 flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder={`New ${title.toLowerCase().replace(/s$/, '')}…`}
          className="input"
        />
        <button onClick={add} className="btn-primary whitespace-nowrap">
          Add
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <ul className="mt-3 divide-y divide-line">
        {rows.length === 0 && <li className="py-2 text-sm text-muted">None yet</li>}
        {rows.map((r) => (
          <li key={r.id} className="flex items-center justify-between py-2 text-sm">
            <span className="text-ink">{r.name}</span>
            <span className="space-x-3">
              <button onClick={() => rename(r)} className="font-medium text-brand-700 hover:underline">
                Rename
              </button>
              <button onClick={() => remove(r)} className="text-muted hover:underline">
                Delete
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Org() {
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Departments & Positions"
        crumb="Departments"
        subtitle="Positions describe the job (Receptionist, Doctor…). Permissions come from the role on each employee, not from here."
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <OrgList table="departments" title="Departments" hint="Clinical, Front Desk, Administration…" />
        <OrgList table="positions" title="Positions" hint="Receptionist, Aesthetician, IV Therapist, Doctor…" />
      </div>
    </div>
  );
}
