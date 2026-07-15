import { useCallback, useEffect, useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { supabase } from '../lib/supabase';

interface DeviceRow {
  id: string;
  name: string;
  is_active: boolean;
  last_seen_at: string | null;
  created_at: string;
  branch: { name: string } | null;
}

const dateFmt = new Intl.DateTimeFormat('en-PH', {
  timeZone: 'Asia/Manila',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

export function Kiosks() {
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    supabase
      .from('attendance_devices')
      .select('id, name, is_active, last_seen_at, created_at, branch:branches(name)')
      .order('created_at', { ascending: false })
      .then(({ data }) => setRows((data as unknown as DeviceRow[]) ?? []));
  }, []);

  useEffect(load, [load]);

  const toggle = async (d: DeviceRow) => {
    setError(null);
    const { error: err } = await supabase
      .from('attendance_devices')
      .update({ is_active: !d.is_active })
      .eq('id', d.id);
    if (err) setError(err.message);
    else load();
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Kiosk devices"
        crumb="Kiosks"
        subtitle="Shared branch tablets. New kiosks are registered from the mobile app on the device itself (admin sign-in → “Set up this device as a branch kiosk”). Deactivating a device blocks its punches immediately."
      />

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <div className="card overflow-x-auto">
        <table className="fm-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Branch</th>
              <th>Last punch</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-muted">
                  No kiosks registered yet.
                </td>
              </tr>
            )}
            {rows.map((d) => (
              <tr key={d.id}>
                <td className="font-semibold text-ink">{d.name}</td>
                <td className="text-muted">{d.branch?.name ?? '—'}</td>
                <td className="text-muted">
                  {d.last_seen_at ? dateFmt.format(new Date(d.last_seen_at)) : 'Never'}
                </td>
                <td>
                  <span
                    className={
                      d.is_active
                        ? 'pill bg-green-100 text-green-700'
                        : 'pill bg-gray-100 text-gray-500'
                    }
                  >
                    {d.is_active ? 'Active' : 'Deactivated'}
                  </span>
                </td>
                <td className="text-right">
                  <button onClick={() => toggle(d)} className="text-sm font-medium text-brand-700 hover:underline">
                    {d.is_active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
