export function csvCell(value: string | number | boolean | null): string {
  const text = value == null ? '' : String(value);
  // Quoting alone does not stop spreadsheets from evaluating formula cells.
  const safe = /^\s*[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function downloadCsv(filename: string, rows: (string | number | boolean | null)[][]) {
  const blob = new Blob([`\ufeff${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function printReport() {
  const cleanup = () => document.body.classList.remove('printing-report');
  document.body.classList.add('printing-report');
  window.addEventListener('afterprint', cleanup, { once: true });
  try {
    window.print();
  } catch (error) {
    cleanup();
    throw error;
  }
}
