/**
 * RFC 4180-style CSV parser with per-row error reporting.
 * Handles quoted fields, escaped quotes (""), commas and newlines inside quotes, CRLF/LF/CR
 * line endings and a trailing newline. A malformed row is reported with its line number
 * instead of aborting the whole file.
 */
export interface CsvRow {
  rowNumber: number;   // 1-based data row (header excluded)
  line: number;        // 1-based physical line where the row starts
  cells: string[];
  error?: string;
}

export interface CsvResult {
  headers: string[];
  rows: CsvRow[];
  fatal?: string;
}

export function parseCsv(text: string, maxRows = Infinity): CsvResult {
  const records: { line: number; cells: string[]; error?: string }[] = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const startLine = line;
    const cells: string[] = [];
    let error: string | undefined;
    // Parse one record.
    for (;;) {
      let cell = "";
      if (text[i] === '"') {
        i++;
        let closed = false;
        while (i < n) {
          const ch = text[i];
          if (ch === '"') {
            if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
            i++;
            closed = true;
            break;
          }
          if (ch === "\n") line++;
          cell += ch;
          i++;
        }
        if (!closed) {
          error = `A quoted value starting on line ${startLine} is never closed. Check for a stray double quote.`;
          // Recover: skip to the end of the starting line so later rows still parse.
          cells.push(cell);
          break;
        }
        // After a closing quote only a delimiter or line end is valid.
        while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
          if (!error) error = `Unexpected text after a closing quote on line ${line}.`;
          cell += text[i++];
        }
      } else {
        while (i < n && text[i] !== "," && text[i] !== "\n" && text[i] !== "\r") {
          if (text[i] === '"' && !error) error = `Unexpected double quote inside an unquoted value on line ${line}.`;
          cell += text[i++];
        }
      }
      cells.push(cell);
      if (i >= n) break;
      if (text[i] === ",") { i++; continue; }
      // Line end.
      if (text[i] === "\r") i++;
      if (text[i] === "\n") i++;
      line++;
      break;
    }
    if (error && cells.length && /never closed/.test(error)) {
      // Unterminated quote swallowed the rest of the file; stop here.
      records.push({ line: startLine, cells, error });
      break;
    }
    const blank = cells.length === 1 && cells[0].trim() === "";
    if (!blank) records.push({ line: startLine, cells, error });
    if (records.length > maxRows + 1) break;
  }
  if (!records.length) return { headers: [], rows: [], fatal: "The file is empty." };
  const [head, ...data] = records;
  if (head.error) return { headers: [], rows: [], fatal: `The header row is malformed: ${head.error}` };
  const headers = head.cells.map((h) => h.trim());
  const rows: CsvRow[] = data.map((r, idx) => {
    let error = r.error;
    if (!error && r.cells.length !== headers.length) {
      error = `Row has ${r.cells.length} values but the header has ${headers.length}. A value may contain an unquoted comma.`;
    }
    return { rowNumber: idx + 1, line: r.line, cells: r.cells, error };
  });
  return { headers, rows };
}
