import { describe, expect, it } from 'vitest';
import { csvRows, parseDate, parseProgramFile, parseText, parseTimeRange, detectType } from '../src/import';

const ctx = { start_date: '2026-05-12', end_date: '2026-05-17' };

// Минимальный zip без сжатия (method 0) — чтобы собрать .xlsx/.docx прямо в тесте.
function zip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (d: Uint8Array) => { let c = 0xffffffff; for (const b of d) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  for (const [name, content] of Object.entries(files)) {
    const nb = enc.encode(name), data = enc.encode(content), crc = crc32(data);
    const lh = new Uint8Array(30 + nb.length); const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nb.length, true); lh.set(nb, 30);
    const ch = new Uint8Array(46 + nb.length); const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nb.length, true); cv.setUint32(42, offset, true); ch.set(nb, 46);
    parts.push(lh, data); central.push(ch); offset += lh.length + data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

describe('primitives', () => {
  it('parses dates and times', () => {
    expect(parseDate('12 мая, вторник', ctx)?.date).toBe('2026-05-12');
    expect(parseDate('13.05', ctx)?.date).toBe('2026-05-13');
    expect(parseDate('14.05.2026 — Стамбул', ctx)?.date).toBe('2026-05-14');
    expect(parseDate('2026-05-15', ctx)?.date).toBe('2026-05-15');
    expect(parseDate('09:00 экскурсия', ctx)).toBeNull();
    expect(parseTimeRange('9.30 – 12:00 Обзорная')).toMatchObject({ time: '09:30', end: '12:00' });
    expect(parseTimeRange('в 18:00 ужин')).toMatchObject({ time: '18:00', end: null });
    expect(detectType('Вылет в Москву, рейс SU 2137')).toBe('flight');
    expect(detectType('Трансфер в аэропорт')).toBe('transfer');
    expect(detectType('Обзорная экскурсия по городу')).toBe('excursion');
    expect(detectType('Ужин в ресторане')).toBe('meal');
    expect(detectType('Сбор у автобуса')).toBe('meeting');
  });
  it('parses csv with quotes and semicolons', () => {
    expect(csvRows('Дата;Время;Событие\n12.05;09:00;"Экскурсия; обзорная"\n')).toEqual([['Дата', 'Время', 'Событие'], ['12.05', '09:00', 'Экскурсия; обзорная']]);
  });
});

describe('text program (как в Word)', () => {
  it('reads days, times, notes, meeting points and flights', () => {
    const text = `Программа тура «Стамбул за 5 дней»
Тур для тех, кто впервые в Турции.

День 1. 12 мая, вторник
06:30 Сбор в аэропорту Шереметьево у стойки «Солнце Тур»
09:15 Вылет в Стамбул, рейс SU 2136
Прилёт в 13:20 по местному времени.
14:30 – 15:30 Трансфер в отель
Заселение после 15:00.

День 2
09:00–13:00 Обзорная экскурсия по Стамбулу. Посещение Голубой мечети и Айя-Софии. Сбор в лобби отеля.
Возьмите удобную обувь и платок.
19:00 Ужин в ресторане с видом на Босфор

День 3
Свободный день

16.05
10:00 Круиз по Босфору

День 6 — 17 мая
08:00 Трансфер в аэропорт
12:40 Вылет в Москву, рейс SU 2137`;
    const r = parseText(text, ctx);
    expect(r.events.map((e) => [e.local_date, e.local_time, e.type, e.title])).toEqual([
      ['2026-05-12', '06:30', 'meeting', 'Сбор в аэропорту Шереметьево у стойки «Солнце Тур»'],
      ['2026-05-12', '09:15', 'flight', 'Вылет в Стамбул, рейс SU 2136'],
      ['2026-05-12', '14:30', 'transfer', 'Трансфер в отель'],
      ['2026-05-13', '09:00', 'excursion', 'Обзорная экскурсия по Стамбулу'],
      ['2026-05-13', '19:00', 'meal', 'Ужин в ресторане с видом на Босфор'],
      ['2026-05-14', null, 'free', 'Свободный день'],
      ['2026-05-16', '10:00', 'excursion', 'Круиз по Босфору'],
      ['2026-05-17', '08:00', 'transfer', 'Трансфер в аэропорт'],
      ['2026-05-17', '12:40', 'flight', 'Вылет в Москву, рейс SU 2137'],
    ]);
    const [, flight, transfer, excursion] = r.events;
    expect(flight.flight_no).toBe('SU 2136');
    expect(flight.notes).toBe('Прилёт в 13:20 по местному времени.');
    expect(transfer.duration_min).toBe(60);
    expect(transfer.notes).toBe('Заселение после 15:00.');
    expect(excursion.duration_min).toBe(240);
    expect(excursion.meeting_point).toBe('Лобби отеля');
    expect(excursion.notes).toContain('Возьмите удобную обувь');
    expect(r.warnings.join(' ')).toContain('2 строки без времени не вошли');
    expect(r.events[0].meeting_point).toBe('');
  });
});

describe('table program', () => {
  it('reads tab-separated paste from Excel / Google Sheets, carrying the date down', () => {
    const paste = [
      'Дата\tВремя\tСобытие\tМесто сбора\tПримечание',
      '12.05\t07:00\tТрансфер в аэропорт\tЛобби отеля\t',
      '\t10:00 - 12:00\tЭкскурсия в Топкапы\tУ автобуса\tБилеты у гида',
      '13 мая\t19:00\tУжин-круиз\tПристань Эминёню\tДресс-код casual',
    ].join('\n');
    const r = parseText(paste, ctx);
    expect(r.format).toBe('table');
    expect(r.events.map((e) => [e.local_date, e.local_time, e.title, e.meeting_point, e.notes, e.duration_min])).toEqual([
      ['2026-05-12', '07:00', 'Трансфер в аэропорт', 'Лобби отеля', '', 60],
      ['2026-05-12', '10:00', 'Экскурсия в Топкапы', 'У автобуса', 'Билеты у гида', 120],
      ['2026-05-13', '19:00', 'Ужин-круиз', 'Пристань Эминёню', 'Дресс-код casual', 60],
    ]);
  });

  it('reads a real .xlsx with numeric Excel dates/times and shared strings', async () => {
    const shared = ['Дата', 'Время', 'Мероприятие', 'Тип', 'Рейс', 'Обзорная экскурсия', 'Вылет домой', 'перелёт', 'TK 413', 'День 2'];
    const s = (i: number, ref: string) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
    const n = (v: number, ref: string) => `<c r="${ref}"><v>${v}</v></c>`;
    const sheet = `<worksheet><sheetData>
      <row r="1">${s(0, 'A1')}${s(1, 'B1')}${s(2, 'C1')}${s(3, 'D1')}${s(4, 'E1')}</row>
      <row r="2">${n(46154, 'A2')}${n(0.375, 'B2')}${s(5, 'C2')}</row>
      <row r="3">${s(9, 'A3')}${n(0.8125, 'B3')}${s(6, 'C3')}${s(7, 'D3')}${s(8, 'E3')}</row>
    </sheetData></worksheet>`;
    const file = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Программа" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': `<sst>${shared.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`,
      'xl/worksheets/sheet1.xml': sheet,
    });
    const r = await parseProgramFile('program.xlsx', file, ctx);
    expect(r.format).toBe('xlsx');
    expect(r.events.map((e) => [e.local_date, e.local_time, e.type, e.title, e.flight_no])).toEqual([
      ['2026-05-12', '09:00', 'excursion', 'Обзорная экскурсия', ''],
      ['2026-05-13', '19:30', 'flight', 'Вылет домой', 'TK 413'],
    ]);
    expect(r.events[1].warning).toContain('часовой пояс');
  });

  it('reads a .docx with paragraphs (and prefers a table when it has more events)', async () => {
    const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
    const doc = `<w:document><w:body>${p('День 1 — 12 мая')}${p('10:00 Прогулка по набережной')}${p('День 2')}${p('08:30 Сбор у автобуса')}</w:body></w:document>`;
    const r = await parseProgramFile('Программа.docx', zip({ 'word/document.xml': doc }), ctx);
    expect(r.events.map((e) => [e.local_date, e.local_time, e.type])).toEqual([['2026-05-12', '10:00', 'excursion'], ['2026-05-13', '08:30', 'meeting']]);
    expect(parseText('День 1\n09:00 Поездка в Кахетию. Сбор у автобуса.', ctx).events[0].meeting_point).toBe('У автобуса');

    const cell = (t: string) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
    const row = (...c: string[]) => `<w:tr>${c.map(cell).join('')}</w:tr>`;
    const tbl = `<w:tbl>${row('Дата', 'Время', 'Программа')}${row('12.05', '11:00', 'Музей')}${row('', '15:00', 'Обед')}${row('13.05', '09:00', 'Трансфер')}</w:tbl>`;
    const r2 = await parseProgramFile('t.docx', zip({ 'word/document.xml': `<w:document><w:body>${p('Наш тур')}${tbl}</w:body></w:document>` }), ctx);
    expect(r2.events.map((e) => e.title)).toEqual(['Музей', 'Обед', 'Трансфер']);
  });

  it('rejects old formats with a clear message', async () => {
    await expect(parseProgramFile('old.xls', new Uint8Array([0xd0, 0xcf]), ctx)).rejects.toThrow('.xlsx');
  });
});

describe('deflate', () => {
  it('reads compressed .docx entries (method 8)', async () => {
    const xml = `<w:document><w:body><w:p><w:r><w:t>День 1</w:t></w:r></w:p><w:p><w:r><w:t>10:00 Музей</w:t></w:r></w:p></w:body></w:document>`;
    const raw = new Uint8Array(await new Response(new Blob([new TextEncoder().encode(xml)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const enc = new TextEncoder(), name = enc.encode('word/document.xml');
    const lh = new Uint8Array(30 + name.length); const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true); lv.setUint32(18, raw.length, true); lv.setUint16(26, name.length, true); lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length); const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(20, raw.length, true); cv.setUint16(28, name.length, true); ch.set(name, 46);
    const end = new Uint8Array(22); const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(10, 1, true); ev.setUint32(12, ch.length, true); ev.setUint32(16, lh.length + raw.length, true);
    const file = new Uint8Array([...lh, ...raw, ...ch, ...end]);
    const r = await parseProgramFile('p.docx', file, ctx);
    expect(r.events.map((e) => [e.local_date, e.local_time, e.title])).toEqual([['2026-05-12', '10:00', 'Музей']]);
  });
});
