/**
 * Team import: turns spreadsheet rows (from .xlsx or .csv) into validated
 * { name, track } records.
 *
 * Pure and dependency-free so it runs in the browser and in Node unit tests.
 * Reading the .xlsx file itself happens in the page with `read-excel-file`,
 * loaded on demand so judges' iPads never download it.
 */

export interface ImportedTeam {
  name: string;
  track: string;
  /** Spreadsheet row number as the user sees it (1-based, header included). */
  row: number;
}

export interface ImportIssue {
  row: number | null;
  message: string;
}

export interface TeamImportResult {
  teams: ImportedTeam[];
  errors: ImportIssue[];
  warnings: ImportIssue[];
  /** Tracks in order of first appearance, with team counts. */
  tracks: { name: string; count: number }[];
}

export const TEAM_IMPORT_LIMITS = {
  maxTeams: 500,
  maxNameLength: 80,
  maxTrackLength: 60,
  maxFileBytes: 2 * 1024 * 1024,
} as const;

const NAME_HEADERS = ['اسم الفريق', 'الفريق', 'اسم', 'الاسم', 'الفرق', 'team', 'team name', 'teams', 'name'];
const TRACK_HEADERS = ['المسار', 'المسارات', 'مسار', 'المجال', 'المحور', 'track', 'tracks', 'track name', 'category', 'path'];

// Zero-width and bidi control characters that Excel/Word often carry around Arabic text
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g;

/** Cell value -> clean single-line string ('' for empty). */
export function cleanCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return '';
  let s: string;
  if (typeof value === 'number') s = Number.isInteger(value) ? String(value) : String(value);
  else if (value instanceof Date) s = value.toISOString().slice(0, 10);
  else s = String(value);
  return s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

/** Key used to detect the same name typed twice (spacing and Latin case ignored). */
export function nameKey(s: string): string {
  return cleanCell(s).toLowerCase();
}

function headerKey(s: unknown): string {
  return cleanCell(s).toLowerCase().replace(/[:：*()\-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

function findColumn(row: unknown[], candidates: string[]): number {
  const keys = row.map(headerKey);
  for (const c of candidates) {
    const i = keys.indexOf(c);
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * Validate rows from the first sheet (or a CSV).
 * The first non-empty row is treated as the header when it names the columns;
 * otherwise column A is the team name and column B the track.
 */
export function parseTeamRows(rows: unknown[][]): TeamImportResult {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const teams: ImportedTeam[] = [];

  const isEmpty = (r: unknown[] | undefined) => !r || r.every((c) => cleanCell(c) === '');
  const first = rows.findIndex((r) => !isEmpty(r));
  if (first === -1) {
    return { teams, errors: [{ row: null, message: 'الملف فارغ: لا توجد أي بيانات' }], warnings, tracks: [] };
  }

  // The header may sit below a title row: look through the first 10 non-empty rows
  let headerAt = -1;
  let nameCol = -1;
  let trackCol = -1;
  for (let i = first, seen = 0; i < rows.length && seen < 10; i++) {
    if (isEmpty(rows[i])) continue;
    seen++;
    const n = findColumn(rows[i], NAME_HEADERS);
    const t = findColumn(rows[i], TRACK_HEADERS);
    if (n !== -1 || t !== -1) { headerAt = i; nameCol = n; trackCol = t; break; }
  }
  let dataStart = headerAt + 1;

  if (headerAt === -1) {
    nameCol = 0;
    trackCol = 1;
    dataStart = first;
    warnings.push({ row: first + 1, message: 'لم يتم العثور على عناوين الأعمدة، تم اعتبار العمود الأول اسم الفريق والعمود الثاني المسار' });
  } else if (nameCol === -1) {
    return { teams, errors: [{ row: headerAt + 1, message: 'عمود "اسم الفريق" غير موجود في سطر العناوين' }], warnings, tracks: [] };
  } else if (trackCol === -1) {
    return { teams, errors: [{ row: headerAt + 1, message: 'عمود "المسار" غير موجود في سطر العناوين' }], warnings, tracks: [] };
  }

  const seenNames = new Map<string, number>();
  const trackSpelling = new Map<string, string>(); // key -> first spelling seen
  const trackCounts = new Map<string, number>();

  for (let i = dataStart; i < rows.length; i++) {
    const r = rows[i];
    if (isEmpty(r)) continue;
    const rowNo = i + 1;
    const name = cleanCell(r[nameCol]);
    let track = cleanCell(r[trackCol]);

    if (!name) { errors.push({ row: rowNo, message: 'اسم الفريق فارغ' }); continue; }
    if (!track) { errors.push({ row: rowNo, message: `المسار فارغ للفريق "${name}"` }); continue; }
    if (name.length > TEAM_IMPORT_LIMITS.maxNameLength) {
      errors.push({ row: rowNo, message: `اسم الفريق أطول من ${TEAM_IMPORT_LIMITS.maxNameLength} حرفاً` });
      continue;
    }
    if (track.length > TEAM_IMPORT_LIMITS.maxTrackLength) {
      errors.push({ row: rowNo, message: `اسم المسار أطول من ${TEAM_IMPORT_LIMITS.maxTrackLength} حرفاً` });
      continue;
    }

    const nk = nameKey(name);
    const dupOf = seenNames.get(nk);
    if (dupOf !== undefined) {
      errors.push({ row: rowNo, message: `اسم الفريق "${name}" مكرر (ورد أيضاً في السطر ${dupOf})` });
      continue;
    }
    seenNames.set(nk, rowNo);

    // Same track typed with different spacing/case becomes one track
    const tk = nameKey(track);
    if (trackSpelling.has(tk)) track = trackSpelling.get(tk)!;
    else trackSpelling.set(tk, track);
    trackCounts.set(track, (trackCounts.get(track) || 0) + 1);

    teams.push({ name, track, row: rowNo });
  }

  if (teams.length === 0 && errors.length === 0) {
    errors.push({ row: null, message: 'لا توجد فرق في الملف تحت سطر العناوين' });
  }
  if (teams.length > TEAM_IMPORT_LIMITS.maxTeams) {
    errors.push({ row: null, message: `عدد الفرق (${teams.length}) أكبر من الحد المسموح ${TEAM_IMPORT_LIMITS.maxTeams}` });
  }
  if (trackCounts.size === 1 && teams.length > 1) {
    warnings.push({ row: null, message: 'كل الفرق في مسار واحد. تأكد من كتابة المسار الصحيح لكل فريق' });
  }

  return {
    teams,
    errors,
    warnings,
    tracks: [...trackCounts.entries()].map(([name, count]) => ({ name, count })),
  };
}

/** Minimal RFC 4180 CSV parser (quotes, escaped quotes, CRLF, BOM; , ; or tab). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t']
    .map((d) => ({ d, n: firstLine.split(d).length }))
    .sort((a, b) => b.n - a.n)[0].d;

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Order tracks by first appearance in a list of teams. */
export function trackOrder(items: { track?: string | null }[]): string[] {
  const out: string[] = [];
  for (const t of items) {
    const k = t.track ?? '';
    if (!out.includes(k)) out.push(k);
  }
  return out;
}
