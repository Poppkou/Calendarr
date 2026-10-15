// Работа с часовыми поясами без внешних библиотек: только Intl, который есть и в Workers, и в браузерах.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { partsFormatter(tz); return true; } catch { return false; }
}
export const isValidDate = (s: unknown): s is string => {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
export const isValidTime = (s: unknown): s is string => typeof s === 'string' && TIME_RE.test(s);

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

export function zonedParts(ms: number, tz: string): ZonedParts {
  const p: Record<string, number> = {};
  for (const { type, value } of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (type !== 'literal') p[type] = Number(value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour === 24 ? 0 : p.hour, minute: p.minute, second: p.second };
}

/** Смещение пояса относительно UTC в мс в момент ms. */
export function tzOffset(ms: number, tz: string): number {
  const z = zonedParts(ms, tz);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Локальная дата/время в поясе tz → момент UTC (мс).
 * Для несуществующего времени (перевод часов вперёд) берётся момент сразу после перехода,
 * для неоднозначного (перевод назад) — более ранний из двух.
 */
export function zonedToUtc(date: string, time: string | null, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time ?? '00:00').split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = tzOffset(wall - tzOffset(wall, tz), tz);
  let t = wall - off1;
  const off2 = tzOffset(t, tz);
  if (off2 !== off1) {
    // Попали на границу перехода: пробуем оба смещения.
    const a = wall - off2;
    const cands = [t, a].filter((x) => {
      const z = zonedParts(x, tz);
      return z.hour === hh && z.minute === mm && z.day === d;
    });
    t = cands.length ? Math.min(...cands) : Math.max(t, a);
  } else {
    // Неоднозначное время (осенний перевод): проверяем, нет ли более раннего совпадения.
    const earlier = t - 3600_000;
    const z = zonedParts(earlier, tz);
    if (z.hour === hh && z.minute === mm && z.day === d) t = earlier;
  }
  return t;
}

export function formatDateInTz(ms: number, tz: string): string {
  const z = zonedParts(ms, tz);
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
}
export function formatTimeInTz(ms: number, tz: string): string {
  const z = zonedParts(ms, tz);
  return `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string): number {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400_000);
}

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export function humanDate(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

const CITY_RU: Record<string, string> = {
  'Europe/Moscow': 'Москва', 'Europe/Kaliningrad': 'Калининград', 'Europe/Samara': 'Самара',
  'Asia/Yekaterinburg': 'Екатеринбург', 'Asia/Omsk': 'Омск', 'Asia/Novosibirsk': 'Новосибирск',
  'Asia/Krasnoyarsk': 'Красноярск', 'Asia/Irkutsk': 'Иркутск', 'Asia/Yakutsk': 'Якутск',
  'Asia/Vladivostok': 'Владивосток', 'Asia/Magadan': 'Магадан', 'Asia/Kamchatka': 'Камчатка',
  'Europe/Istanbul': 'Стамбул', 'Asia/Dubai': 'Дубай', 'Africa/Cairo': 'Каир', 'Asia/Bangkok': 'Бангкок',
  'Asia/Ho_Chi_Minh': 'Хошимин', 'Asia/Shanghai': 'Пекин', 'Asia/Tokyo': 'Токио', 'Asia/Kolkata': 'Индия',
  'Indian/Maldives': 'Мальдивы', 'Asia/Colombo': 'Шри-Ланка', 'Asia/Makassar': 'Бали', 'Asia/Jakarta': 'Джакарта',
  'Asia/Tbilisi': 'Тбилиси', 'Asia/Yerevan': 'Ереван', 'Asia/Baku': 'Баку', 'Asia/Almaty': 'Алматы',
  'Asia/Tashkent': 'Ташкент', 'Europe/Minsk': 'Минск', 'Europe/Berlin': 'Берлин', 'Europe/Paris': 'Париж',
  'Europe/Rome': 'Рим', 'Europe/Madrid': 'Мадрид', 'Europe/Athens': 'Афины', 'Europe/London': 'Лондон',
  'Europe/Prague': 'Прага', 'Europe/Belgrade': 'Белград', 'Asia/Nicosia': 'Кипр', 'Africa/Tunis': 'Тунис',
  'Asia/Havana': 'Гавана', 'America/Havana': 'Гавана', 'Asia/Seoul': 'Сеул', 'Asia/Kathmandu': 'Катманду',
  'Asia/Manila': 'Манила', 'Asia/Kuala_Lumpur': 'Куала-Лумпур', 'Asia/Singapore': 'Сингапур',
  'Africa/Dar_es_Salaam': 'Занзибар', 'Indian/Mauritius': 'Маврикий', 'Indian/Mahe': 'Сейшелы',
  'America/New_York': 'Нью-Йорк', 'America/Cancun': 'Канкун', 'America/Santo_Domingo': 'Доминикана',
  'UTC': 'UTC',
};
/** Подпись пояса для людей: «Стамбул» или «Asia/Foo» → «Foo». */
export function tzLabel(tz: string): string {
  return CITY_RU[tz] ?? tz.split('/').pop()!.replace(/_/g, ' ');
}
