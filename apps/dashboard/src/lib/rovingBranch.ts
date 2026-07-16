/**
 * Remembered branch selection for roving employees (profiles.branch_id = null):
 * they pick which branch they're at when timing in, and the choice sticks per
 * user on this device. Name is stored too so the picker can render the
 * remembered choice while offline, before the branch list loads.
 */
export interface RememberedBranch {
  id: string;
  name: string;
}

const key = (userId: string) => `fermosa.roving_branch.${userId}`;

export function readRovingBranch(userId: string): RememberedBranch | null {
  try {
    const raw = localStorage.getItem(key(userId));
    if (!raw) return null;
    const v = JSON.parse(raw) as RememberedBranch;
    return v && typeof v.id === 'string' && typeof v.name === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function writeRovingBranch(userId: string, branch: RememberedBranch | null): void {
  try {
    if (branch) localStorage.setItem(key(userId), JSON.stringify(branch));
    else localStorage.removeItem(key(userId));
  } catch {
    // Storage unavailable (private mode etc.) — selection just won't persist.
  }
}
