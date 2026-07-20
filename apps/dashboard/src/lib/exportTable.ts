// Client-side report export — SheetJS used as a writer. Reading workbooks lives
// in importTable.ts and is limited to files a signed-in HR/admin picks from
// their own machine; we still never parse untrusted files from the network.
import * as XLSX from 'xlsx';

export type Cell = string | number | null;

export interface SheetData {
  name: string; // worksheet/tab name
  headers: string[];
  rows: Cell[][];
}

function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Excel worksheet names: ≤31 chars, none of []:*?/\ */
function safeSheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet1';
}

/** Write one or more worksheets to a .xlsx file and download it. */
export function exportXlsx(filename: string, sheets: SheetData[]): void {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet([sheet.headers, ...sheet.rows]);
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(sheet.name));
  }
  XLSX.writeFile(wb, filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`);
}

function csvField(value: Cell): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Write a single table to a .csv file (UTF-8 BOM so Excel reads it) and download. */
export function exportCsv(filename: string, headers: string[], rows: Cell[][]): void {
  const lines = [headers, ...rows].map((r) => r.map(csvField).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(filename.endsWith('.csv') ? filename : `${filename}.csv`, blob);
}
