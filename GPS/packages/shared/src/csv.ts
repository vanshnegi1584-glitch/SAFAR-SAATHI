/**
 * RFC 4180 CSV parser: quoted fields may contain commas, escaped quotes ("") and line breaks.
 * The SafarSaathi schedule relies on this — some Route cells span two lines inside quotes.
 * Returns raw cell strings; callers decide how to trim/normalise.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip UTF-8 BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c !== '"') field += c;
      else if (src[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = false;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (inQuotes) throw new Error('CSV ends inside a quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines carry no data.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}
