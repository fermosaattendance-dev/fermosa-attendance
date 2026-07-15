import { AUDIT_ACTION_LABELS, type AuditLogRow } from '@fermosa/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { exportCsv, type Cell } from '../lib/exportTable';
import { supabase } from '../lib/supabase';

const PAGE = 50;

const labelFor = (action: string) => AUDIT_ACTION_LABELS[action] ?? action;

const fmt = (ts: string) =>
  new Date(ts).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    dateStyle: 'medium',
    timeStyle: 'short',
  });

const inputClass =
  'mt-1 input';
const labelClass = 'block text-xs font-medium text-gray-600';

export function Audit() {
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    let query = supabase
      .from('audit_log_view')
      .select('*')
      .order('created_at', { ascending: false })
      .range(0, limit - 1);
    if (action) query = query.eq('action', action);
    if (from) query = query.gte('created_at', from);
    if (to) query = query.lte('created_at', `${to}T23:59:59`);
    const s = q.trim().replace(/[^\w\s-]/g, '');
    if (s) query = query.or(`actor_name.ilike.*${s}*,record_id.ilike.*${s}*`);
    const { data, error: err } = await query;
    setLoading(false);
    if (err) {
      setError(err.message);
      return;
    }
    setRows((data as AuditLogRow[]) ?? []);
  }, [action, from, to, q, limit]);

  useEffect(() => {
    load();
  }, [load]);

  const actionOptions = useMemo(() => Object.keys(AUDIT_ACTION_LABELS), []);
  const hasMore = rows.length === limit;

  const onExport = () => {
    const headers = ['When (Manila)', 'Action', 'Actor', 'Role', 'Table', 'Record', 'Details'];
    const data: Cell[][] = rows.map((r) => [
      fmt(r.created_at),
      labelFor(r.action),
      r.actor_name ?? '',
      r.actor_role ?? '',
      r.table_name,
      r.record_id ?? '',
      r.details ? JSON.stringify(r.details) : '',
    ]);
    exportCsv(`audit-log-${new Date().toISOString().slice(0, 10)}`, headers, data);
  };

  const resetFilters = () => {
    setAction('');
    setFrom('');
    setTo('');
    setQ('');
    setLimit(PAGE);
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Audit log</h2>
          <p className="text-sm text-gray-500">
            Privileged actions across the company — account changes, reviews, corrections, and 2FA events.
          </p>
        </div>
        <button
          onClick={onExport}
          disabled={rows.length === 0}
          className="btn"
        >
          Export CSV
        </button>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3 card p-4">
        <div>
          <label className={labelClass}>Action</label>
          <select value={action} onChange={(e) => setAction(e.target.value)} className={inputClass}>
            <option value="">All actions</option>
            {actionOptions.map((a) => (
              <option key={a} value={a}>
                {labelFor(a)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>From</label>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className={labelClass}>To</label>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
        </div>
        <div className="flex-1">
          <label className={labelClass}>Search (actor or record id)</label>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. Helena, or a record UUID"
            className={`${inputClass} w-full`}
          />
        </div>
        <button
          onClick={resetFilters}
          className="btn"
        >
          Clear
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-4 overflow-hidden card">
        <table className="w-full text-left text-sm">
          <thead className="bg-ground text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">Actor</th>
              <th className="px-4 py-2 font-medium">Target</th>
              <th className="px-4 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => (
              <tr key={r.id} className="align-top hover:bg-gray-50">
                <td className="whitespace-nowrap px-4 py-2 text-gray-500">{fmt(r.created_at)}</td>
                <td className="px-4 py-2">
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                    {labelFor(r.action)}
                  </span>
                </td>
                <td className="px-4 py-2 text-gray-900">
                  {r.actor_name ?? <span className="text-gray-400">system</span>}
                </td>
                <td className="px-4 py-2 text-gray-600">
                  <div>{r.table_name}</div>
                  {r.record_id && (
                    <div className="font-mono text-xs text-gray-400">{r.record_id}</div>
                  )}
                </td>
                <td className="px-4 py-2 font-mono text-xs text-gray-500">
                  {r.details ? JSON.stringify(r.details) : '—'}
                </td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-gray-400">
                  No audit entries match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex items-center gap-3">
        {hasMore && (
          <button
            onClick={() => setLimit((n) => n + PAGE)}
            disabled={loading}
            className="btn"
          >
            {loading ? 'Loading…' : 'Load more'}
          </button>
        )}
        <span className="text-xs text-gray-400">{rows.length} shown</span>
      </div>
    </div>
  );
}
