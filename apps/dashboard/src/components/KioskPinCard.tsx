import { useState } from 'react';
import { supabase } from '../lib/supabase';

/**
 * Self-service kiosk PIN — an employee sets or changes their own 4–6 digit PIN
 * (used to time in on a shared branch tablet). Goes through the set_my_pin RPC,
 * which always targets auth.uid(), so no one can set another person's PIN.
 */
export function KioskPinCard() {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    setMsg(null);
    if (!/^[0-9]{4,6}$/.test(pin)) {
      setMsg({ ok: false, text: 'PIN must be 4–6 digits.' });
      return;
    }
    setBusy(true);
    const { error } = await supabase.rpc('set_my_pin', { p_pin: pin });
    setBusy(false);
    if (error) {
      setMsg({ ok: false, text: error.message });
    } else {
      setMsg({ ok: true, text: 'Kiosk PIN saved. Use it to time in on a branch tablet.' });
      setPin('');
    }
  };

  return (
    <div className="card mt-4 p-5">
      <h3 className="text-sm font-semibold text-ink">Kiosk PIN</h3>
      <p className="mt-1 text-sm text-muted">
        4–6 digits, used to time in on a shared branch tablet. You can change it anytime.
      </p>
      <div className="mt-3 flex gap-2">
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          inputMode="numeric"
          placeholder="1234"
          className="input w-40"
        />
        <button
          onClick={() => void save()}
          disabled={busy || pin.length < 4}
          className="btn disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Set PIN'}
        </button>
      </div>
      {msg && (
        <p className={`mt-2 text-sm ${msg.ok ? 'text-green-700' : 'text-red-600'}`}>{msg.text}</p>
      )}
    </div>
  );
}
