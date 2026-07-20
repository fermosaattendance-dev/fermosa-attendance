import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';
import { writeKioskConfig } from '../lib/kioskWeb';
import { supabase } from '../lib/supabase';

interface DeviceRow {
  id: string;
  name: string;
  is_active: boolean;
  last_seen_at: string | null;
  created_at: string;
  branch: { name: string } | null;
}

interface BranchOption {
  id: string;
  name: string;
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
  const navigate = useNavigate();
  const [rows, setRows] = useState<DeviceRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [setupBranchId, setSetupBranchId] = useState('');
  const [setupName, setSetupName] = useState('');
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  const load = useCallback(() => {
    supabase
      .from('attendance_devices')
      .select('id, name, is_active, last_seen_at, created_at, branch:branches(name)')
      .order('created_at', { ascending: false })
      .then(({ data }) => setRows((data as unknown as DeviceRow[]) ?? []));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    supabase
      .from('branches')
      .select('id, name')
      .eq('is_active', true)
      .order('name')
      .then(({ data }) => setBranches((data as BranchOption[]) ?? []));
  }, []);

  // Register THIS browser as a branch kiosk, store the returned device key
  // locally, and open the locked terminal. The key is shown only once.
  const activate = async () => {
    if (!setupBranchId || !setupName.trim()) return;
    setSetupBusy(true);
    setSetupError(null);
    const { data, error: rpcErr } = await supabase.rpc('register_kiosk_device', {
      p_branch_id: setupBranchId,
      p_name: setupName.trim(),
    });
    setSetupBusy(false);
    if (rpcErr) {
      setSetupError(rpcErr.message);
      return;
    }
    const result = data as { device_id: string; device_key: string };
    const branch = branches.find((b) => b.id === setupBranchId)!;
    writeKioskConfig({
      device_id: result.device_id,
      device_key: result.device_key,
      branch_id: setupBranchId,
      branch_name: branch.name,
      device_name: setupName.trim(),
    });
    navigate('/kiosk');
  };

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
        subtitle="Shared branch terminals. Set up a kiosk on the device it will live on (a tablet or laptop at the branch); staff then punch there with their employee code + PIN + selfie. Deactivating a device blocks its punches immediately."
      />

      <div className="card mb-6 p-5">
        <h2 className="text-sm font-semibold text-ink">Set up this device as a kiosk</h2>
        <p className="mt-1 text-sm text-muted">
          Do this <span className="font-medium">on the shared tablet/laptop</span> that will stay at
          the branch. This browser locks into the kiosk terminal; exiting needs an admin sign-in.
          Each employee also needs a Kiosk PIN (Employees → open the person → Set PIN).
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-500">Branch</span>
            <select
              value={setupBranchId}
              onChange={(e) => setSetupBranchId(e.target.value)}
              className="mt-1 input w-56"
            >
              <option value="">— select a branch —</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-xs font-medium text-gray-500">Device name</span>
            <input
              value={setupName}
              onChange={(e) => setSetupName(e.target.value)}
              placeholder="e.g. Front desk tablet"
              className="mt-1 input w-56"
            />
          </label>
          <button
            onClick={() => void activate()}
            disabled={!setupBranchId || !setupName.trim() || setupBusy}
            className="btn-primary disabled:opacity-50"
          >
            {setupBusy ? 'Activating…' : 'Activate kiosk mode'}
          </button>
        </div>
        {setupError && <p className="mt-3 text-sm text-red-600">{setupError}</p>}
      </div>

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
