// Reading spreadsheets HR uploads (payslip amounts). Counterpart to
// exportTable.ts, which only writes. We now also *read* workbooks — but only
// files chosen by a signed-in HR/admin from their own machine, never anything
// untrusted from the network.
import * as XLSX from 'xlsx';
import type { PayslipManualAmounts } from '@fermosa/shared';

/**
 * Parse the first worksheet of an .xlsx/.csv file into rows of raw cells.
 *
 * `raw: false` returns each cell's FORMATTED text. That matters for employee
 * codes: most of Fermosa's are zero-padded ("0005"), and the default typed read
 * turns those into the number 5, which then matches nothing. Amount cells come
 * back as strings and are parsed by toAmount() below.
 */
export async function parseSheet(file: File): Promise<unknown[][]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const first = wb.SheetNames[0];
  if (!first) return [];
  const ws = wb.Sheets[first]!;
  return XLSX.utils.sheet_to_json(ws, {
    header: 1,
    blankrows: false,
    defval: '',
    raw: false,
  }) as unknown[][];
}

/**
 * Compare employee codes ignoring leading zeros, so a sheet that lost them
 * (Excel loves turning "0005" into 5) still finds "0005". Callers must only
 * accept a loose hit when it is unambiguous — see matchByCode().
 */
export function looseCode(s: string): string {
  return s.trim().toLowerCase().replace(/^0+(?=.)/, '');
}

/**
 * Resolve a sheet code to an employee: exact match wins; otherwise fall back to
 * a leading-zero-insensitive match, but only when exactly one employee matches
 * (never guess between "005" and "0005").
 */
export function matchByCode<T extends { code: string }>(
  sheetCode: string,
  employees: T[],
): T | null {
  const want = sheetCode.trim().toLowerCase();
  if (!want) return null;
  const exact = employees.find((e) => e.code.trim().toLowerCase() === want);
  if (exact) return exact;
  const loose = employees.filter((e) => looseCode(e.code) === looseCode(sheetCode));
  return loose.length === 1 ? loose[0]! : null;
}

/**
 * Header aliases. HR's own sheet has quirks (a typo'd "add allowanace", mixed
 * casing, "Pag-IBIG" vs "pagibig"), so match loosely on a normalised key
 * rather than requiring exact text.
 */
const COLUMN_ALIASES: Record<string, keyof PayslipManualAmounts | 'code' | 'name'> = {
  employeecode: 'code',
  code: 'code',
  empcode: 'code',
  name: 'name',
  employee: 'name',
  employeename: 'name',
  addallowance: 'add_allowance',
  addallowanace: 'add_allowance', // the typo in the owner's sheet
  additionalallowance: 'add_allowance',
  holiday: 'holiday_pay',
  holidaypay: 'holiday_pay',
  otherless: 'others_less',
  othersless: 'others_less',
  adjustmentless: 'adjustment_less',
  adjustmentsless: 'adjustment_less',
  cashadvance: 'cash_advance',
  sss: 'sss',
  philhealth: 'philhealth',
  pagibig: 'pagibig',
  others: 'others',
};

/** Lower-case and strip everything that isn't a letter or digit. */
function normaliseHeader(h: unknown): string {
  return String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ParsedRow {
  code: string;
  /** Name as it appeared in the sheet — display only; matching is by code. */
  sheetName: string;
  amounts: PayslipManualAmounts;
  /** Column headers whose value could not be read as a number. */
  invalid: string[];
}

export interface ParseResult {
  rows: ParsedRow[];
  /** Manual-amount columns we recognised (for showing HR what was picked up). */
  matchedColumns: string[];
  /** Headers in the sheet we did not recognise (ignored, reported). */
  unknownColumns: string[];
  error?: string;
}

const AMOUNT_KEYS: (keyof PayslipManualAmounts)[] = [
  'add_allowance',
  'holiday_pay',
  'others_less',
  'adjustment_less',
  'cash_advance',
  'sss',
  'philhealth',
  'pagibig',
  'others',
];

/** Blank → 0; "1,234.50" / " 500 " → number; anything else → null (flagged). */
function toAmount(v: unknown): number | null {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/[,₱\s]/g, '');
  if (s === '' || s === '-') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Turn raw sheet cells into per-employee amounts. Rows are matched on employee
 * CODE (the template carries it); the name column is carried for display only.
 */
export function readPayslipSheet(cells: unknown[][]): ParseResult {
  const empty: ParseResult = { rows: [], matchedColumns: [], unknownColumns: [] };
  if (cells.length < 2) {
    return { ...empty, error: 'The sheet has no data rows.' };
  }

  const headerRow = cells[0]!;
  const colFor: (keyof PayslipManualAmounts | 'code' | 'name' | null)[] = [];
  const matchedColumns: string[] = [];
  const unknownColumns: string[] = [];

  headerRow.forEach((h, idx) => {
    const key = COLUMN_ALIASES[normaliseHeader(h)] ?? null;
    colFor[idx] = key;
    const label = String(h ?? '').trim();
    if (!label) return;
    if (key && key !== 'code' && key !== 'name') matchedColumns.push(label);
    else if (!key) unknownColumns.push(label);
  });

  if (!colFor.includes('code')) {
    return {
      ...empty,
      unknownColumns,
      error:
        'No "Employee code" column found. Use the Download template button so every row carries the code.',
    };
  }

  const rows: ParsedRow[] = [];
  for (let r = 1; r < cells.length; r++) {
    const row = cells[r]!;
    let code = '';
    let sheetName = '';
    const amounts: PayslipManualAmounts = {
      add_allowance: 0,
      holiday_pay: 0,
      others_less: 0,
      adjustment_less: 0,
      cash_advance: 0,
      sss: 0,
      philhealth: 0,
      pagibig: 0,
      others: 0,
    };
    const invalid: string[] = [];

    colFor.forEach((key, idx) => {
      if (!key) return;
      const raw = row[idx];
      if (key === 'code') code = String(raw ?? '').trim();
      else if (key === 'name') sheetName = String(raw ?? '').trim();
      else {
        const n = toAmount(raw);
        if (n === null) invalid.push(String(headerRow[idx] ?? key));
        else amounts[key] = n;
      }
    });

    // Skip entirely blank lines (trailing rows Excel likes to include).
    if (!code && !sheetName && AMOUNT_KEYS.every((k) => amounts[k] === 0) && !invalid.length) continue;
    rows.push({ code, sheetName, amounts, invalid });
  }

  return { rows, matchedColumns, unknownColumns };
}
