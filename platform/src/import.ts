// Загрузка программы тура из документа: Excel (.xlsx), Word (.docx), CSV/TSV или вставленного текста.
// Без сторонних библиотек: .xlsx и .docx — это zip-архивы с XML, распаковываем через DecompressionStream.
import { addDays, daysBetween, isValidDate } from './time';

export interface ImportedEvent {
  local_date: string;
  local_time: string | null;
  duration_min: number;
  type: string;
  title: string;
  meeting_point: string;
  location: string;
  address: string;
  notes: string;
  flight_no: string;
  line: number;          // номер строки в исходнике — для подсказок менеджеру
  warning?: string;
}
export interface ImportResult { events: ImportedEvent[]; warnings: string[]; format: string }
export interface ImportContext { start_date: string; end_date: string }

// ---------- zip ----------

const MAX_UNPACKED = 30 * 1024 * 1024; // защита от «zip-бомб»

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_UNPACKED) { await reader.cancel(); throw new ImportError('Файл слишком большой после распаковки'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export async function unzip(buf: Uint8Array, want: (name: string) => boolean): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ImportError('Файл повреждён или это не .xlsx/.docx');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!want(name)) continue;
    const ln = dv.getUint16(local + 26, true), lx = dv.getUint16(local + 28, true);
    const start = local + 30 + ln + lx;
    const raw = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
  }
  return out;
}

// ---------- XML-помощники (структуры простые, регулярных выражений достаточно) ----------

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m);
const textOf = (xml: string, tag: string) => {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let s = '', m: RegExpExecArray | null;
  while ((m = re.exec(xml))) s += unxml(m[1]);
  return s;
};

// ---------- xlsx ----------

function colIndex(ref: string): number {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export type Cell = string | number | null;

export async function xlsxRows(buf: Uint8Array): Promise<Cell[][]> {
  const files = await unzip(buf, (n) => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const dec = new TextDecoder();
  const shared: string[] = [];
  const ss = files.get('xl/sharedStrings.xml');
  if (ss) {
    for (const m of dec.decode(ss).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textOf(m[1], 't'));
  }
  // Первый лист по порядку в книге.
  let sheetPath = '';
  const wb = files.get('xl/workbook.xml'), rels = files.get('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const rid = /<sheet\b[^>]*r:id="([^"]+)"/.exec(dec.decode(wb))?.[1];
    const target = rid && new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(dec.decode(rels))?.[1]
      || rid && new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(dec.decode(rels))?.[1];
    if (target) sheetPath = 'xl/' + target.replace(/^\/?xl\//, '').replace(/^\//, '');
  }
  const sheet = files.get(sheetPath) ?? [...files.entries()].filter(([n]) => n.startsWith('xl/worksheets/')).sort()[0]?.[1];
  if (!sheet) throw new ImportError('В файле Excel не найден лист с данными');
  const rows: Cell[][] = [];
  for (const rm of dec.decode(sheet).matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: Cell[] = [];
    for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], inner = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const t = /\bt="(\w+)"/.exec(attrs)?.[1];
      const idx = ref ? colIndex(ref) : row.length;
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val: Cell = null;
      if (t === 's' && v != null) val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = textOf(inner, 't');
      else if (t === 'str' || t === 'e') val = v != null ? unxml(v) : '';
      else if (t === 'b') val = v === '1' ? 'да' : 'нет';
      else if (v != null && v !== '') val = Number(v);
      row[idx] = val;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    rows.push(row);
  }
  return rows;
}

// ---------- docx ----------

export async function docxContent(buf: Uint8Array): Promise<{ rows: Cell[][]; lines: string[] }> {
  const files = await unzip(buf, (n) => n === 'word/document.xml');
  const doc = files.get('word/document.xml');
  if (!doc) throw new ImportError('В файле Word не найден текст документа');
  const xml = new TextDecoder().decode(doc);
  const para = (p: string) => unxml(p.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n').replace(/<(?!\/?w:t[ >])[^>]+>/g, '').replace(/<\/?w:t[^>]*>/g, '')).trim();
  const rows: Cell[][] = [];
  const lines: string[] = [];
  // Таблицы — в строки; остальной текст — в абзацы, в порядке документа.
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => {
    for (const tr of tbl.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)) {
      const cells = [...tr[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((tc) =>
        [...tc[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => para(p[0])).filter(Boolean).join('\n'));
      rows.push(cells);
    }
    return '';
  });
  for (const p of body.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
    const t = para(p[0]);
    if (t) lines.push(...t.split('\n'));
  }
  return { rows, lines };
}

// ---------- csv / tsv ----------

export function csvRows(text: string): Cell[][] {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const delim = first.includes('\t') ? '\t' : (first.split(';').length > first.split(',').length ? ';' : ',');
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"' && cur === '') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

// ---------- распознавание дат, времени и типов ----------

const MONTHS: Record<string, number> = {
  янв: 1, фев: 2, мар: 3, апр: 4, мая: 5, май: 5, июн: 6, июл: 7, авг: 8, сен: 9, окт: 10, ноя: 11, дек: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const pad = (n: number) => String(n).padStart(2, '0');

/** Год для «12 мая» — тот, при котором дата ближе всего к датам тура. */
function pickYear(month: number, day: number, ctx: ImportContext): string | null {
  const y0 = Number(ctx.start_date.slice(0, 4));
  let best: string | null = null, bestDist = Infinity;
  for (const y of [y0 - 1, y0, y0 + 1]) {
    const d = `${y}-${pad(month)}-${pad(day)}`;
    if (!isValidDate(d)) continue;
    const dist = Math.min(Math.abs(daysBetween(ctx.start_date, d)), Math.abs(daysBetween(ctx.end_date, d)));
    if (dist < bestDist) { best = d; bestDist = dist; }
  }
  return best;
}

/** Находит дату в начале строки или в ячейке. Возвращает дату и длину совпадения. */
export function parseDate(s: string, ctx: ImportContext): { date: string; len: number } | null {
  const t = s.trim().toLowerCase();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m && isValidDate(`${m[1]}-${m[2]}-${m[3]}`)) return { date: `${m[1]}-${m[2]}-${m[3]}`, len: m[0].length };
  m = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?![\d:])/.exec(t);
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let date: string | null;
      if (m[3]) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); date = `${y}-${pad(mo)}-${pad(d)}`; if (!isValidDate(date)) date = null; }
      else date = pickYear(mo, d, ctx);
      if (date) return { date, len: m[0].length };
    }
  }
  m = /^(\d{1,2})\s+([а-яёa-z]{3,})\.?(?:\s+(\d{4}))?/.exec(t);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3)];
    if (mo) {
      const d = Number(m[1]);
      const date = m[3] ? `${m[3]}-${pad(mo)}-${pad(d)}` : pickYear(mo, d, ctx);
      if (date && isValidDate(date)) return { date, len: m[0].length };
    }
  }
  return null;
}

/** «День 3», «3 день», «Day 3» → дата от начала тура. */
export function parseDayNumber(s: string, ctx: ImportContext): string | null {
  const m = /^(?:день|day)\s*№?\s*(\d{1,2})\b|^(\d{1,2})\s*(?:-?й\s*)?день\b/i.exec(s.trim());
  if (!m) return null;
  return addDays(ctx.start_date, Number(m[1] ?? m[2]) - 1);
}

/** Время в начале строки: «09:00», «9.00», «в 9:00», «09:00–12:30». */
export function parseTimeRange(s: string): { time: string; end: string | null; len: number } | null {
  const m = /^\s*(?:в\s+|с\s+)?([01]?\d|2[0-3])[:.]([0-5]\d)(?:\s*(?:[-–—]|до)\s*([01]?\d|2[0-3])[:.]([0-5]\d))?/i.exec(s);
  if (!m) return null;
  return { time: `${pad(Number(m[1]))}:${m[2]}`, end: m[3] ? `${pad(Number(m[3]))}:${m[4]}` : null, len: m[0].length };
}

function minutesBetween(a: string, b: string): number {
  const [h1, m1] = a.split(':').map(Number), [h2, m2] = b.split(':').map(Number);
  let d = h2 * 60 + m2 - (h1 * 60 + m1);
  if (d < 0) d += 1440;
  return d;
}

export function detectType(text: string): string {
  const t = text.toLowerCase();
  if (/вылет|прил[её]т|рейс|перел[её]т|flight|аэропорт.*регистрац/.test(t)) return 'flight';
  if (/трансфер|transfer|переезд/.test(t)) return 'transfer';
  if (/завтрак|обед|ужин|breakfast|lunch|dinner|дегустац/.test(t)) return 'meal';
  if (/заселен|выселен|check-?in|check-?out|размещен/.test(t)) return 'hotel';
  if (/свободн|отдых на пляже|free time/.test(t)) return 'free';
  if (/^сбор\b|встреча группы|сбор группы|сбор у|сбор в/.test(t)) return 'meeting';
  if (/экскурс|музе|прогулк|посещен|осмотр|тур по|поездк|круиз|мастер-класс|шоу|парк|храм|собор|дворец/.test(t)) return 'excursion';
  return 'other';
}

const FLIGHT_RE = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?-?(\d{2,4})\b/;
function detectFlight(text: string): string {
  const m = FLIGHT_RE.exec(text);
  return m ? `${m[1]} ${m[2]}` : '';
}
function detectMeeting(text: string): string {
  const m = /(?:сбор|встреча)\s+(?:группы\s+)?(в|у|на|возле)\s+([^.;,\n]{3,80})/i.exec(text);
  if (!m) return '';
  // «в лобби отеля» → «Лобби отеля», но «у автобуса» → «У автобуса» (иначе теряется смысл).
  const keep = /^(у|возле)$/i.test(m[1]);
  const place = (keep ? m[1].toLowerCase() + ' ' : '') + m[2].trim();
  return place.charAt(0).toUpperCase() + place.slice(1);
}
const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 100, b = n % 10;
  return a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
};

/** Длинный текст: первое предложение — название, остальное — в заметки. */
function splitTitle(text: string): { title: string; rest: string } {
  const clean = text.replace(/^[\s\-–—:.)•*]+/, '').trim();
  // Несколько предложений: первое — название, остальное — описание.
  const m = /^(.{8,120}?)[.!?;]\s+(?=[A-ZА-ЯЁ«"])/.exec(clean);
  if (m) return { title: m[1].trim(), rest: clean.slice(m[0].length).trim() };
  if (clean.length <= 120) return { title: clean.replace(/\.$/, ''), rest: '' };
  return { title: clean.slice(0, 120).replace(/\s+\S*$/, '') + '…', rest: clean };
}

function makeEvent(date: string, time: string | null, end: string | null, text: string, line: number): ImportedEvent {
  const { title, rest } = splitTitle(text);
  // Тип — по названию; описание учитываем, только если название ничего не подсказало.
  let type = detectType(title);
  if (type === 'other') type = detectType(rest);
  return {
    local_date: date, local_time: time, duration_min: time && end ? minutesBetween(time, end) : (type === 'flight' ? 0 : 60),
    // «Сбор в аэропорту…» — место уже в названии, дублировать не нужно.
    type, title: title.slice(0, 200), meeting_point: type === 'meeting' && /^(сбор|встреча)/i.test(title) ? '' : detectMeeting(text), location: '', address: '',
    notes: rest.slice(0, 3000), flight_no: type === 'flight' ? detectFlight(text) : '', line,
  };
}

// ---------- текст программы ----------

export function parseProgramText(lines: string[], ctx: ImportContext): ImportResult {
  const events: ImportedEvent[] = [];
  const warnings: string[] = [];
  let date: string | null = null;
  let last: ImportedEvent | null = null;
  let orphan = 0;
  lines.forEach((raw, i) => {
    const line = raw.replace(/ /g, ' ').trim();
    if (!line) return;
    const n = i + 1;
    // Заголовок дня: «День 2», «День 2. 13 мая», «13 мая, среда», «13.05»
    const byNumber = parseDayNumber(line, ctx);
    let rest = line;
    if (byNumber) {
      date = byNumber;
      rest = line.replace(/^(?:день|day)\s*№?\s*\d{1,2}|^\d{1,2}\s*(?:-?й\s*)?день/i, '').replace(/^[\s.,:–—-]+/, '');
      const explicit = parseDate(rest, ctx);
      if (explicit) { date = explicit.date; rest = rest.slice(explicit.len); }
      last = null;
      rest = rest.replace(/^[\s.,:–—(-]+/, '').replace(/^(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|пн|вт|ср|чт|пт|сб|вс)\b[\s.,:)–—-]*/i, '');
      if (!rest || !parseTimeRange(rest)) {
        if (rest && /свободн/i.test(rest)) events.push({ ...makeEvent(date, null, null, rest, n), type: 'free' });
        return;
      }
    } else {
      const d = parseDate(line, ctx);
      if (d) {
        const after = line.slice(d.len).replace(/^[\s.,:–—(-]+/, '').replace(/^(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|пн|вт|ср|чт|пт|сб|вс)\b[\s.,:)–—-]*/i, '');
        if (!after || after.length < 3 || parseTimeRange(after)) {
          date = d.date; last = null; rest = after;
          if (!rest) return;
        }
      }
    }
    const tr = parseTimeRange(rest);
    if (tr) {
      const text = rest.slice(tr.len).replace(/^[\s\-–—:.)]+/, '');
      if (!text) return;
      if (!date) { date = ctx.start_date; warnings.push(`Строка ${n}: не нашёл день или дату выше — поставил первый день тура.`); }
      last = makeEvent(date, tr.time, tr.end, text, n);
      events.push(last);
      return;
    }
    // Строка без времени: свободный день — отдельным событием, остальное — в описание предыдущего события.
    if (date && /^свободн/i.test(rest)) { last = null; events.push({ ...makeEvent(date, null, null, rest, n), type: 'free' }); return; }
    if (last) {
      const e: ImportedEvent = last;
      e.notes = (e.notes ? e.notes + '\n' : '') + rest;
      if (!e.meeting_point) e.meeting_point = detectMeeting(rest);
      if (e.type === 'flight' && !e.flight_no) e.flight_no = detectFlight(rest);
    } else orphan++;
  });
  if (orphan) warnings.push(`${orphan} ${plural(orphan, 'строка без времени не вошла', 'строки без времени не вошли', 'строк без времени не вошли')} в программу (например, общее описание тура).`);
  return { events, warnings, format: 'text' };
}

// ---------- таблица ----------

type Col = 'date' | 'time' | 'end' | 'title' | 'type' | 'meeting' | 'location' | 'address' | 'duration' | 'flight' | 'notes';
const HEADERS: [Col, RegExp][] = [
  ['date', /^(дата|date|день|day)/],
  ['end', /(оконч|конец|до\b|end)/],
  ['time', /(время|time|начало|start)/],
  ['meeting', /(сбор|место встреч|встреча|meeting)/],
  ['address', /(адрес|address)/],
  ['location', /(место|локац|объект|location|place|где)/],
  ['duration', /(длит|продолж|duration)/],
  ['flight', /(рейс|flight)/],
  ['type', /^(тип|вид|type)/],
  ['notes', /(примеч|заметк|коммент|важно|взять|описан|notes|comment|детали)/],
  ['title', /(событи|назван|меропр|программ|что|activity|event|услуг|title|наимен)/],
];

function cellText(c: Cell): string { return c == null ? '' : String(c).trim(); }

/** Excel хранит даты числами (дни с 1899-12-30), время — долей суток. */
function excelDate(n: number): string | null {
  if (n < 20000 || n > 80000) return null;
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000).toISOString().slice(0, 10);
}
function excelTime(n: number): string | null {
  const frac = n % 1;
  if (n >= 1 && frac === 0) return null;
  const mins = Math.round(frac * 1440) % 1440;
  return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
}

const TYPE_WORDS: Record<string, string> = {
  перелет: 'flight', перелёт: 'flight', вылет: 'flight', рейс: 'flight', трансфер: 'transfer', сбор: 'meeting',
  экскурсия: 'excursion', отель: 'hotel', гостиница: 'hotel', питание: 'meal', еда: 'meal', свободное: 'free', другое: 'other',
};

export function parseProgramTable(rows: Cell[][], ctx: ImportContext): ImportResult {
  const warnings: string[] = [];
  const nonEmpty = rows.map((r, i) => ({ r, i })).filter(({ r }) => r.some((c) => cellText(c)));
  if (!nonEmpty.length) return { events: [], warnings: ['Таблица пустая'], format: 'table' };
  // Заголовок — первая строка, где узнаются хотя бы две колонки.
  let headerAt = -1;
  let map: Partial<Record<Col, number>> = {};
  for (const { r, i } of nonEmpty.slice(0, 8)) {
    const m: Partial<Record<Col, number>> = {};
    r.forEach((c, idx) => {
      const t = cellText(c).toLowerCase();
      if (!t || t.length > 40) return;
      const hit = HEADERS.find(([col, re]) => m[col] === undefined && re.test(t));
      if (hit) m[hit[0]] = idx;
    });
    if (Object.keys(m).length >= 2 && (m.title !== undefined || m.time !== undefined)) { headerAt = i; map = m; break; }
  }
  if (headerAt < 0) {
    // Без заголовка: угадываем колонки по содержимому.
    const sample = nonEmpty.slice(0, 20).map(({ r }) => r);
    const width = Math.max(...sample.map((r) => r.length));
    const score = (idx: number, test: (c: Cell) => boolean) => sample.filter((r) => test(r[idx] ?? null)).length;
    for (let idx = 0; idx < width; idx++) {
      if (map.date === undefined && score(idx, (c) => typeof c === 'number' ? !!excelDate(c) : !!(parseDate(cellText(c), ctx) || parseDayNumber(cellText(c), ctx))) >= Math.max(1, sample.length / 4)) { map.date = idx; continue; }
      if (map.time === undefined && score(idx, (c) => typeof c === 'number' ? c < 1 : !!parseTimeRange(cellText(c))) >= Math.max(1, sample.length / 3)) { map.time = idx; continue; }
      if (map.title === undefined && score(idx, (c) => cellText(c).length > 3 && typeof c !== 'number') >= sample.length / 3) { map.title = idx; continue; }
      if (map.title !== undefined && map.notes === undefined && score(idx, (c) => cellText(c).length > 3) > 0) map.notes = idx;
    }
    if (map.title === undefined) return { events: [], warnings: ['Не удалось понять, где в таблице названия событий. Добавьте строку заголовков: Дата, Время, Событие, Место сбора, Примечание.'], format: 'table' };
  }
  const events: ImportedEvent[] = [];
  let date: string | null = null;
  let skipped = 0;
  for (const { r, i } of nonEmpty) {
    if (i <= headerAt) continue;
    const get = (col: Col) => (map[col] !== undefined ? r[map[col]!] ?? null : null);
    const n = i + 1;
    // Дата: может быть только в первой строке дня.
    const dc = get('date');
    if (dc != null && cellText(dc)) {
      const d = typeof dc === 'number' ? excelDate(dc) : (parseDayNumber(cellText(dc), ctx) ?? parseDate(cellText(dc), ctx)?.date ?? null);
      if (d) date = d;
    }
    let title = cellText(get('title'));
    const tc = get('time');
    let time: string | null = null, end: string | null = null;
    if (typeof tc === 'number') time = excelTime(tc);
    else if (cellText(tc)) {
      const tr = parseTimeRange(cellText(tc));
      if (tr) { time = tr.time; end = tr.end; }
    }
    if (!title && !time) continue;
    if (!title) { skipped++; continue; }
    // Время могли вписать прямо в название.
    if (!time) { const tr = parseTimeRange(title); if (tr) { time = tr.time; end = tr.end; title = title.slice(tr.len).replace(/^[\s\-–—:.)]+/, ''); } }
    const ec = get('end');
    if (!end && ec != null) end = typeof ec === 'number' ? excelTime(ec) : parseTimeRange(cellText(ec))?.time ?? null;
    if (!date) { date = ctx.start_date; warnings.push(`Строка ${n}: нет даты — поставил первый день тура.`); }
    const ev = makeEvent(date, time, end, title, n);
    const typeCell = cellText(get('type')).toLowerCase();
    if (typeCell) ev.type = TYPE_WORDS[typeCell] ?? Object.entries(TYPE_WORDS).find(([w]) => typeCell.startsWith(w.slice(0, 5)))?.[1] ?? ev.type;
    const meeting = cellText(get('meeting')); if (meeting) ev.meeting_point = meeting.slice(0, 200);
    const loc = cellText(get('location')); if (loc) ev.location = loc.slice(0, 200);
    const addr = cellText(get('address')); if (addr) ev.address = addr.slice(0, 300);
    const notes = cellText(get('notes')); if (notes) ev.notes = [ev.notes, notes].filter(Boolean).join('\n').slice(0, 3000);
    const fl = cellText(get('flight')); if (fl) { ev.flight_no = fl.toUpperCase().slice(0, 20); ev.type = 'flight'; }
    const dur = get('duration');
    if (dur != null && cellText(dur)) {
      const t = cellText(dur).toLowerCase();
      const h = /(\d+(?:[.,]\d+)?)\s*ч/.exec(t), mi = /(\d+)\s*мин/.exec(t);
      const v = typeof dur === 'number' ? (dur < 1 ? Math.round(dur * 1440) : dur) : h || mi ? Math.round((h ? parseFloat(h[1].replace(',', '.')) * 60 : 0) + (mi ? Number(mi[1]) : 0)) : Number(t);
      if (Number.isFinite(v) && v > 0 && v < 20160) ev.duration_min = Math.round(v);
    }
    events.push(ev);
  }
  if (skipped) warnings.push(`${skipped} ${plural(skipped, 'строка', 'строки', 'строк')} со временем, но без названия, ${skipped === 1 ? 'пропущена' : 'пропущены'}.`);
  return { events, warnings, format: 'table' };
}

// ---------- общий вход ----------

export class ImportError extends Error {}

export async function parseProgramFile(name: string, buf: Uint8Array, ctx: ImportContext): Promise<ImportResult> {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  let res: ImportResult;
  if (ext === 'xlsx' || (isZip && ext !== 'docx' && name === '')) {
    res = { ...parseProgramTable(await xlsxRows(buf), ctx), format: 'xlsx' };
  } else if (ext === 'docx') {
    const { rows, lines } = await docxContent(buf);
    const fromTable = rows.length >= 2 ? parseProgramTable(rows, ctx) : null;
    const fromText = parseProgramText(lines, ctx);
    res = fromTable && fromTable.events.length >= fromText.events.length ? { ...fromTable, format: 'docx' } : { ...fromText, format: 'docx' };
  } else if (ext === 'xls' || ext === 'doc') {
    throw new ImportError('Старый формат .xls/.doc не поддерживается. Сохраните файл как .xlsx или .docx («Файл → Сохранить как»).');
  } else if (isZip) {
    throw new ImportError('Поддерживаются файлы .xlsx, .docx, .csv и .txt');
  } else {
    const text = new TextDecoder().decode(buf);
    res = parseText(text, ctx);
  }
  return finish(res, ctx);
}

/** Вставленный текст: если похоже на таблицу (табуляции из Excel) — разбираем как таблицу, иначе как программу. */
export function parseText(text: string, ctx: ImportContext): ImportResult {
  const lines = text.split(/\r?\n/);
  const tabbed = lines.filter((l) => l.includes('\t')).length;
  const semi = lines.filter((l) => (l.match(/;/g) || []).length >= 2).length;
  if (tabbed >= Math.max(2, lines.filter((l) => l.trim()).length / 2) || semi >= Math.max(2, lines.filter((l) => l.trim()).length / 2)) {
    const t = parseProgramTable(csvRows(text), ctx);
    if (t.events.length) return t;
  }
  return parseProgramText(lines, ctx);
}

export function finish(res: ImportResult, ctx: ImportContext): ImportResult {
  for (const e of res.events) {
    if (e.local_date < addDays(ctx.start_date, -2) || e.local_date > addDays(ctx.end_date, 2)) e.warning = 'Дата вне дат тура — проверьте';
    else if (e.type === 'flight') e.warning = 'Проверьте часовой пояс: время вылета указывается по аэропорту вылета';
  }
  if (!res.events.length && !res.warnings.length) res.warnings.push('Не нашёл ни одного события. Нужны строки со временем, например: «09:00 Обзорная экскурсия».');
  return res;
}
