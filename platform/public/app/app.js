'use strict';
// Приложение туриста: расписание тура, обратный отсчёт, уведомления, работа без интернета.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим / нет места */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const toast = (text, ms = 3500) => {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), ms);
  };
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
  const telHref = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '');

  async function api(path, opts = {}, timeoutMs = 15000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(path, { cache: 'no-store', ...opts, signal: ctl.signal, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(data.error || `Ошибка ${res.status}`); e.status = res.status; throw e; }
      if (res.headers.get('x-pt-offline')) {
        // Ответ из кэша service worker: данные есть, но сеть недоступна.
        const e = new Error('offline'); e.offlineData = data; e.savedAt = Number(res.headers.get('x-pt-saved-at')) || 0; throw e;
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});

  const m = location.pathname.match(/^\/t\/([A-Za-z0-9_-]{20,64})\/?$/);
  if (!m) return entryScreen();
  const token = m[1];
  LS.set('pt.lastToken', token);
  const link = document.createElement('link');
  link.rel = 'manifest'; link.href = `/t/${token}/manifest.webmanifest`;
  document.head.appendChild(link);

  // ---------- Время ----------
  const fmtCache = {};
  const fmt = (tz, opts) => (fmtCache[tz + JSON.stringify(opts)] ||= new Intl.DateTimeFormat('ru-RU', { timeZone: tz, ...opts }));
  const timeIn = (ms, tz) => fmt(tz, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  const dateIn = (ms, tz) => {
    const p = Object.fromEntries(fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  const dayTitle = (date) => {
    const [y, mo, d] = date.split('-').map(Number);
    return fmt('UTC', { weekday: 'long', day: 'numeric', month: 'long' }).format(Date.UTC(y, mo - 1, d));
  };
  const daysBetween = (a, b) => {
    const p = (s) => { const [y, mo, d] = s.split('-').map(Number); return Date.UTC(y, mo - 1, d); };
    return Math.round((p(b) - p(a)) / 86400000);
  };
  const countdown = (ms) => {
    if (ms <= 0) return 'сейчас';
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60;
    if (d >= 1) return `через ${d} дн ${h} ч`;
    if (h >= 1) return `${h}:${String(mi).padStart(2, '0')}:${String(se).padStart(2, '0')}`;
    return `${mi}:${String(se).padStart(2, '0')}`;
  };

  // ---------- Состояние ----------
  const KEY = `pt.data.${token}`;
  let data = LS.get(KEY, null);
  let fetchedAt = LS.get(KEY + '.at', 0);
  let skew = LS.get('pt.skew', 0); // поправка на неверные часы телефона
  let netError = null;
  let invalid = false;
  let openId = null;
  let firstRender = true;
  const SEEN = `pt.seen.${token}`;
  let seen = LS.get(SEEN, null);
  const now = () => Date.now() + skew;

  async function load({ quiet = false } = {}) {
    try {
      const fresh = await api(`/api/t/${encodeURIComponent(token)}`);
      skew = Math.abs(fresh.serverTime - Date.now()) > 60000 ? fresh.serverTime - Date.now() : 0;
      LS.set('pt.skew', skew);
      const changed = data && data.group.version !== fresh.group.version;
      data = fresh; fetchedAt = Date.now(); netError = null; invalid = false;
      LS.set(KEY, data); LS.set(KEY + '.at', fetchedAt);
      if (!seen) { seen = Object.fromEntries(data.events.map((e) => [e.id, e.rev])); LS.set(SEEN, seen); }
      if (changed && !quiet) toast('Расписание обновлено');
      trackMessages(quiet);
      applyBrand();
      syncPushSubscription();
    } catch (e) {
      if (e.status === 404) { invalid = true; LS.del(KEY); data = null; }
      else {
        if (e.offlineData && (!data || e.savedAt > fetchedAt)) { data = e.offlineData; fetchedAt = e.savedAt; applyBrand(); }
        netError = e.offlineData || navigator.onLine === false ? 'Нет интернета' : 'Не удалось обновить';
      }
    }
    render();
  }

  // ---------- Сообщения турфирмы ----------
  const MSG_SEEN = `pt.msgseen.${token}`;
  let msgSeenAt = LS.get(MSG_SEEN, null);
  const freshMsgIds = new Set(); // «новые» в этом сеансе — подсвечиваем, пока страница открыта
  function trackMessages(quiet) {
    const list = (data && data.messages) || [];
    if (msgSeenAt == null) { msgSeenAt = list.length ? list[0].at : 0; LS.set(MSG_SEEN, msgSeenAt); return; }
    const fresh = list.filter((m) => m.at > msgSeenAt);
    fresh.forEach((m) => freshMsgIds.add(m.id));
    if (fresh.length) {
      if (!quiet) toast('📣 Новое сообщение от турфирмы');
      msgSeenAt = list[0].at; LS.set(MSG_SEEN, msgSeenAt);
    }
  }
  const timeAgo = (ms) => {
    const m = Math.round((now() - ms) / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин назад`;
    if (m < 24 * 60) return `${Math.round(m / 60)} ч назад`;
    return fmt(data.group.tz, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  };
  let showAllMsgs = false;
  function messagesHtml() {
    const list = (data.messages || []);
    if (!list.length) return '';
    const shown = showAllMsgs ? list : list.slice(0, 3);
    return `<div class="card msgs" id="msgs"><h3>📣 Сообщения от турфирмы</h3>
      ${shown.map((m) => `<div class="msg ${freshMsgIds.has(m.id) ? 'new' : ''}">
        <div class="msg-h"><b>${esc(m.title)}</b><span>${freshMsgIds.has(m.id) ? '<span class="badge">новое</span> ' : ''}${esc(timeAgo(m.at))}</span></div>
        <div class="msg-b">${esc(m.body)}</div></div>`).join('')}
      ${list.length > 3 ? `<button class="link-btn" id="allMsgs">${showAllMsgs ? 'Свернуть' : `Показать все (${list.length})`}</button>` : ''}
    </div>`;
  }

  // ---------- «Я опаздываю» / «Нужна помощь» ----------
  const tourActive = () => {
    const today = dateIn(now(), data.group.tz);
    return daysBetween(data.group.start_date, today) >= -1 && daysBetween(today, data.group.end_date) >= -1;
  };
  function phonesHtml() {
    const g = data.group, list = [];
    if (g.guide_phone) list.push([`Гид${g.guide_name ? ' ' + g.guide_name : ''}`, g.guide_phone]);
    if (data.agency.phone) list.push([data.agency.name, data.agency.phone]);
    return list.map(([n, p]) => `<a class="btn" href="${esc(telHref(p))}">📞 ${esc(n)}: ${esc(p)}</a>`).join('');
  }
  function quickHtml() {
    const recent = (data.alerts || []).filter((a) => now() - a.created_at < 6 * 3600000 && a.kind !== 'message');
    const last = recent[0];
    const state = last ? `<p class="quick-state ${last.status === 'done' ? 'ok' : ''}">${last.status === 'done'
      ? `✅ ${last.handled_by ? esc(last.handled_by) + ' получил(а)' : 'Менеджер получил'} ваше сообщение`
      : '⏳ Сообщение отправлено, менеджер скоро ответит'} · ${esc(timeAgo(last.created_at))}</p>` : '';
    return `<div class="quick">
      <button class="btn quick-late" data-alert="late">⏰ Я опаздываю</button>
      <button class="btn quick-help" data-alert="help">🆘 Нужна помощь</button>
    </div>${state}`;
  }

  const sheetRoot = document.createElement('div');
  document.body.appendChild(sheetRoot);
  function closeSheet() { sheetRoot.innerHTML = ''; }
  function openAlertSheet(kind) {
    let minutes = 10;
    const savedPhone = LS.get('pt.phone', '');
    const isLate = kind === 'late';
    sheetRoot.innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-modal="true">
      <h2>${isLate ? '⏰ Я опаздываю' : '🆘 Нужна помощь'}</h2>
      <p class="sub">${isLate ? 'Менеджер и гид сразу узнают, что вы задерживаетесь.' : 'Менеджер получит сообщение и свяжется с вами.'}</p>
      ${isLate ? `<div class="label">На сколько примерно?</div><div class="chips">${[5, 10, 15, 30, 60].map((m) => `<button class="chip ${m === minutes ? 'on' : ''}" data-min="${m}">${m === 60 ? 'час+' : m + ' мин'}</button>`).join('')}</div>` : ''}
      <label class="label" for="alertText">${isLate ? 'Комментарий (необязательно)' : 'Что случилось?'}</label>
      <textarea id="alertText" maxlength="1000" placeholder="${isLate ? 'Например: стою в пробке, буду у отеля' : 'Например: потерял паспорт, нужна помощь с такси'}"></textarea>
      <label class="label" for="alertPhone">Ваш телефон для связи (необязательно)</label>
      <input id="alertPhone" type="tel" maxlength="40" value="${esc(savedPhone)}" placeholder="+7 900 000-00-00">
      <div class="err-text" id="alertErr"></div>
      <div class="sheet-actions"><button class="btn" id="alertCancel">Отмена</button><button class="btn primary" id="alertSend">Отправить менеджеру</button></div>
      <div class="sheet-phones">${phonesHtml()}</div>
    </div></div>`;
    const bg = sheetRoot.querySelector('.sheet-bg');
    bg.addEventListener('click', (e) => { if (e.target === bg) closeSheet(); });
    $('#alertCancel').onclick = closeSheet;
    sheetRoot.querySelectorAll('[data-min]').forEach((b) => b.addEventListener('click', () => {
      minutes = Number(b.dataset.min);
      sheetRoot.querySelectorAll('[data-min]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    $('#alertSend').onclick = async () => {
      const btn = $('#alertSend');
      const text = $('#alertText').value.trim(), contact = $('#alertPhone').value.trim();
      if (!isLate && !text) { $('#alertErr').textContent = 'Опишите коротко, что случилось'; return; }
      if (contact) LS.set('pt.phone', contact);
      btn.disabled = true; $('#alertErr').textContent = '';
      try {
        await api(`/api/t/${token}/alert`, { method: 'POST', body: JSON.stringify({ kind, minutes: isLate ? minutes : undefined, text, contact }) });
        sheetRoot.querySelector('.sheet').innerHTML = `<h2>✅ Менеджер получил сообщение</h2>
          <p class="sub">Когда менеджер ответит, сообщение появится здесь и придёт уведомлением. Если очень срочно — позвоните:</p>
          <div class="sheet-phones">${phonesHtml()}</div>
          <div class="sheet-actions"><button class="btn primary" id="alertOk">Хорошо</button></div>`;
        $('#alertOk').onclick = closeSheet;
        load({ quiet: true });
      } catch (e) {
        btn.disabled = false;
        $('#alertErr').textContent = e.offlineData || navigator.onLine === false
          ? 'Нет интернета — сообщение не отправилось. Позвоните по телефону ниже.'
          : (e.message || 'Не получилось отправить. Позвоните по телефону ниже.');
      }
    };
  }

  function applyBrand() {
    if (!data) return;
    const c = /^#[0-9a-f]{6}$/i.test(data.agency.brand_color) ? data.agency.brand_color : '#6366f1';
    document.documentElement.style.setProperty('--accent', c);
    document.title = data.group.title;
  }

  // ---------- Уведомления ----------
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const pushCapable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  let pushOn = false;

  function pushState() {
    if (pushOn) return 'on';
    if (!pushCapable) return isIOS && !standalone ? 'ios-install' : 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    return 'off';
  }
  const u8 = (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
  const swReady = () => Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('Service worker не запустился')), 10000))]);

  async function subscribe(interactive) {
    const key = data && data.push.vapidPublicKey;
    if (!key) throw new Error('Сервер уведомлений ещё не настроен турфирмой');
    const reg = await swReady();
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options && sub.options.applicationServerKey) {
      const cur = new Uint8Array(sub.options.applicationServerKey), want = u8(key);
      if (cur.length !== want.length || cur.some((b, i) => b !== want[i])) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) {
      if (!interactive && Notification.permission !== 'granted') return null;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(key) });
    }
    await api(`/api/t/${token}/webpush`, { method: 'POST', body: JSON.stringify(sub.toJSON()) });
    (reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'meta', token, vapid: key });
    return sub;
  }

  // При каждом открытии сверяем подписку с сервером: если браузер её обновил или сервер отключил — восстановится.
  let syncing = false;
  async function syncPushSubscription() {
    if (!pushCapable || syncing || Notification.permission !== 'granted') { pushOn = false; return; }
    syncing = true;
    try { pushOn = !!(await subscribe(false)); } catch { pushOn = false; } finally { syncing = false; render(); }
  }

  async function enablePush(btn) {
    btn.disabled = true;
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { toast('Уведомления не разрешены'); render(); return; }
      await subscribe(true);
      pushOn = true;
      toast('Готово! Напоминания включены');
      testPush(true);
    } catch (e) {
      toast(e.message || 'Не получилось включить уведомления');
    } finally { btn.disabled = false; render(); }
  }

  async function testPush(silent) {
    try {
      const r = await api(`/api/t/${token}/test`, { method: 'POST' });
      if (!silent) toast(r.sent ? 'Отправили проверочное уведомление' : 'Отправили. Если не пришло — проверьте настройки уведомлений');
    } catch (e) { if (!silent) toast(e.message); }
  }

  // ---------- Отрисовка ----------
  function render() {
    const root = $('#root');
    if (invalid) {
      root.innerHTML = `<div class="entry"><h1>Ссылка не работает</h1><p class="sub">Возможно, турфирма выдала вам новую ссылку. Попросите её у менеджера или введите код из памятки.</p><a class="btn primary block" style="margin-top:20px" href="/app/">Ввести код</a></div>`;
      return;
    }
    if (!data) {
      root.innerHTML = `<div class="entry"><h1>Нет связи</h1><p class="sub">Не удалось загрузить расписание. Проверьте интернет — как только он появится, всё загрузится.</p><button class="btn primary block" style="margin-top:20px" id="retry">Повторить</button></div>`;
      $('#retry').onclick = () => load();
      return;
    }
    const g = data.group, labels = data.tzLabels || {};
    const t = now();
    const evs = data.events;
    const active = evs.filter((e) => !e.cancelled && e.local_time);
    const current = active.find((e) => e.starts_at <= t && t < e.starts_at + Math.max(e.duration_min, 1) * 60000);
    const next = active.find((e) => e.starts_at > t);
    const hero = current || next;
    const today = dateIn(t, g.tz);

    const days = new Map();
    for (const e of evs) { if (!days.has(e.local_date)) days.set(e.local_date, []); days.get(e.local_date).push(e); }

    const ageMin = Math.round((Date.now() - fetchedAt) / 60000);
    const status = netError
      ? `<div class="status warn">📡 ${esc(netError)}. Показано расписание, сохранённое ${ageMin < 1 ? 'только что' : ageMin < 60 ? ageMin + ' мин назад' : Math.round(ageMin / 60) + ' ч назад'}.</div>` : '';

    root.innerHTML = `<div class="wrap">
      <header class="top">
        <div><div class="agency">${esc(data.agency.name)}</div><h1>${esc(g.title)}</h1>
          <div class="sub">${esc(rangeText(g.start_date, g.end_date))} · время местное (${esc(labels[g.tz] || g.tz)})</div></div>
        ${g.guide_phone || data.agency.phone ? `<a class="icon-btn" href="${esc(telHref(g.guide_phone || data.agency.phone))}">📞 Связь</a>` : ''}
      </header>
      ${status}
      ${freshMsgIds.size ? messagesHtml() : ''}
      ${hero ? heroHtml(hero, !!current, labels, g) : `<div class="card"><b>${evs.length ? 'Программа тура завершена' : 'Расписание скоро появится'}</b><p class="sub">${evs.length ? 'Спасибо, что путешествовали с нами!' : 'Турфирма ещё заполняет программу — заходите позже.'}</p></div>`}
      ${tourActive() ? quickHtml() : ''}
      ${freshMsgIds.size ? '' : messagesHtml()}
      ${notifyHtml()}
      ${[...days.entries()].map(([date, list]) => dayHtml(date, list, today, t, g, labels)).join('')}
      ${g.notes ? `<div class="card"><h3 style="margin-bottom:8px">📝 Памятка</h3><div class="memo">${esc(g.notes)}</div></div>` : ''}
      ${g.guide_name || g.guide_phone || data.agency.phone ? `<div class="card"><h3 style="margin-bottom:8px">Контакты</h3>
        ${g.guide_name || g.guide_phone ? `<p>Гид: ${esc(g.guide_name)} ${g.guide_phone ? `<a href="${esc(telHref(g.guide_phone))}">${esc(g.guide_phone)}</a>` : ''}</p>` : ''}
        ${data.agency.phone ? `<p>${esc(data.agency.name)}: <a href="${esc(telHref(data.agency.phone))}">${esc(data.agency.phone)}</a></p>` : ''}
        ${tourActive() ? '' : quickHtml()}</div>` : (tourActive() ? '' : `<div class="card"><h3 style="margin-bottom:8px">Связь с турфирмой</h3>${quickHtml()}</div>`)}
      <div class="foot">${data.participant.name ? esc(data.participant.name) + ' · ' : ''}Ваш код: <code>${esc(data.participant.code)}</code><br>По этому коду расписание можно открыть на другом телефоне.</div>
    </div>`;

    root.querySelectorAll('[data-ev]').forEach((el) => el.addEventListener('click', () => {
      const id = el.dataset.ev;
      openId = openId === id ? null : id;
      const ev = evs.find((e) => e.id === id);
      seen = seen || {};
      if (ev && seen[id] !== ev.rev) { seen[id] = ev.rev; LS.set(SEEN, seen); }
      render();
    }));
    root.querySelectorAll('a[data-stop]').forEach((a) => a.addEventListener('click', (e) => e.stopPropagation()));
    const pb = $('#pushBtn'); if (pb) pb.onclick = () => enablePush(pb);
    const tb = $('#testBtn'); if (tb) tb.onclick = () => testPush(false);
    root.querySelectorAll('[data-alert]').forEach((b) => b.addEventListener('click', () => openAlertSheet(b.dataset.alert)));
    const am = $('#allMsgs'); if (am) am.onclick = () => { showAllMsgs = !showAllMsgs; render(); };

    if (firstRender) {
      firstRender = false;
      const el = document.getElementById(`day-${today}`);
      if (el && today !== evs[0]?.local_date) setTimeout(() => el.scrollIntoView({ block: 'start' }), 50);
    }
    tickCountdown();
  }

  function rangeText(a, b) {
    const f = (s) => { const [y, mo, d] = s.split('-').map(Number); return fmt('UTC', { day: 'numeric', month: 'long' }).format(Date.UTC(y, mo - 1, d)); };
    return a === b ? f(a) : `${f(a)} — ${f(b)}`;
  }

  function homeTime(e, g, labels) {
    if (!e.local_time || !g.home_tz || g.home_tz === e.tz) return '';
    const h = timeIn(e.starts_at, g.home_tz);
    return h === e.local_time ? '' : `${h} ${labels[g.home_tz] || g.home_tz}`;
  }

  function heroHtml(e, isNow, labels, g) {
    const tzNote = e.tz !== g.tz ? ` (${esc(labels[e.tz] || e.tz)})` : '';
    const map = safeUrl(e.map_url);
    return `<div class="card hero">
      <div class="lbl">${isNow ? 'Сейчас' : 'Далее'}</div>
      <div class="ttl">${esc(e.icon)} ${esc(e.title)}${e.flight_no && !e.title.includes(e.flight_no) ? ' ' + esc(e.flight_no) : ''}</div>
      <div class="when">${esc(dayWord(e.local_date))}, ${esc(e.local_time)}${tzNote}</div>
      ${isNow ? '' : `<div class="count" data-count="${e.starts_at}"></div>`}
      ${e.meeting_point || e.location ? `<div class="place">📍 ${esc(e.meeting_point ? 'Сбор: ' + e.meeting_point : e.location)}</div>` : ''}
      ${map ? `<div class="row-btns"><a class="btn" href="${esc(map)}" target="_blank" rel="noopener">🗺 Маршрут</a></div>` : ''}
    </div>`;
  }
  function dayWord(date) {
    const today = dateIn(now(), data.group.tz);
    if (date === today) return 'Сегодня';
    if (daysBetween(today, date) === 1) return 'Завтра';
    return dayTitle(date);
  }

  function notifyHtml() {
    const st = pushState();
    const tg = data.telegram, tgOn = !!data.channels.telegram;
    const tgBtn = tg && !tgOn ? `<a class="btn" href="${esc(tg.url)}" target="_blank" rel="noopener">✈️ Получать в Telegram</a>` : '';
    const ics = `<a class="btn" href="/api/t/${esc(token)}/calendar.ics">📅 В календарь телефона</a>`;
    const tgLine = tgOn ? '<p class="ok" style="margin-top:6px">✓ Telegram подключён</p>' : '';
    if (st === 'on') {
      return `<div class="card notify"><p class="ok">✓ Напоминания включены на этом устройстве</p>${tgLine}
        <div class="row-btns"><button class="btn" id="testBtn">🔔 Проверить</button>${tgBtn}${ics}</div></div>`;
    }
    if (st === 'ios-install') {
      return `<div class="card notify"><h3>🔔 Включите напоминания</h3>
        <p>На iPhone уведомления работают, если добавить расписание на экран «Домой»:</p>
        <ol class="steps"><li>Нажмите <b>«Поделиться»</b> ⬆️ внизу Safari</li><li>Выберите <b>«На экран „Домой“»</b></li><li>Откройте появившуюся иконку и нажмите «Включить напоминания»</li></ol>
        ${tgLine}<div class="row-btns">${tgBtn}${ics}</div>
        ${tgBtn ? '<p style="margin-top:8px">Или просто подключите Telegram — так проще всего.</p>' : ''}</div>`;
    }
    const head = st === 'denied'
      ? '<h3>🔕 Уведомления запрещены</h3><p>Разрешите уведомления для этого сайта в настройках браузера или подключите Telegram.</p>'
      : st === 'unsupported'
        ? '<h3>🔔 Напоминания</h3><p>Этот браузер не поддерживает уведомления. Подключите Telegram или добавьте тур в календарь телефона.</p>'
        : '<h3>🔔 Не пропустите трансфер</h3><p>Мы заранее напомним о сборе, экскурсиях и вылете и сообщим, если что-то изменится.</p>';
    return `<div class="card notify">${head}${tgLine}<div class="row-btns">
      ${st === 'off' ? '<button class="btn primary" id="pushBtn">Включить напоминания</button>' : ''}${tgBtn}${ics}</div></div>`;
  }

  function dayHtml(date, list, today, t, g, labels) {
    const n = daysBetween(g.start_date, date) + 1;
    const inTour = date >= g.start_date && date <= g.end_date;
    return `<section class="day" id="day-${esc(date)}">
      <div class="day-h"><b>${inTour ? `День ${n}` : esc(dayTitle(date))}</b><span>${inTour ? esc(dayTitle(date)) : ''}</span>${date === today ? '<span class="badge">Сегодня</span>' : ''}</div>
      ${list.map((e) => evHtml(e, t, g, labels)).join('')}
    </section>`;
  }

  function evHtml(e, t, g, labels) {
    const end = e.starts_at + Math.max(e.duration_min, 1) * 60000;
    const allDayEnd = e.local_time ? end : e.starts_at + 86400000;
    const cls = ['ev'];
    if (e.cancelled) cls.push('cancelled');
    else if (allDayEnd < t) cls.push('past');
    else if (e.local_time && e.starts_at <= t && t < end) cls.push('now');
    const changed = seen && seen[e.id] != null && seen[e.id] !== e.rev;
    const home = homeTime(e, g, labels);
    const place = e.meeting_point ? 'Сбор: ' + e.meeting_point : e.location;
    const tzOther = e.tz !== g.tz ? (labels[e.tz] || e.tz) : '';
    const open = openId === e.id;
    const map = safeUrl(e.map_url) || (e.address ? `https://yandex.ru/maps/?text=${encodeURIComponent(e.address)}` : '');
    const endTime = e.local_time && e.duration_min ? timeIn(end, e.tz) : '';
    return `<button class="${cls.join(' ')}" data-ev="${esc(e.id)}">
      <div class="ev-time">${e.local_time ? esc(e.local_time) : '—'}${tzOther ? `<small>${esc(tzOther)}</small>` : ''}${home && !tzOther ? `<small>${esc(home)}</small>` : ''}</div>
      <div class="ev-main">
        <div class="ev-title">${esc(e.icon)} ${esc(e.title)} ${e.cancelled ? '<span class="badge gray">Отменено</span>' : changed ? '<span class="badge warn">Изменено</span>' : ''}</div>
        ${place ? `<div class="ev-meta">${esc(place)}</div>` : ''}
        ${open ? `<div class="ev-details">
          <div><span class="k">${esc(e.type_name)}${e.local_time ? '' : ' · весь день'}</span></div>
          ${endTime ? `<div><span class="k">Время:</span> ${esc(e.local_time)}–${esc(endTime)}${tzOther ? ' (' + esc(tzOther) + ')' : ''}</div>` : ''}
          ${home ? `<div><span class="k">Дома в это время:</span> ${esc(home)}</div>` : ''}
          ${e.flight_no ? `<div><span class="k">Рейс:</span> ${esc(e.flight_no)}</div>` : ''}
          ${e.meeting_point ? `<div><span class="k">Место сбора:</span> ${esc(e.meeting_point)}</div>` : ''}
          ${e.location ? `<div><span class="k">Место:</span> ${esc(e.location)}</div>` : ''}
          ${e.address ? `<div><span class="k">Адрес:</span> ${esc(e.address)}</div>` : ''}
          ${e.notes ? `<div class="notes">${esc(e.notes)}</div>` : ''}
          ${map ? `<div><a class="btn" data-stop href="${esc(map)}" target="_blank" rel="noopener">🗺 Открыть на карте</a></div>` : ''}
        </div>` : ''}
      </div>
    </button>`;
  }

  function tickCountdown() {
    document.querySelectorAll('[data-count]').forEach((el) => { el.textContent = countdown(Number(el.dataset.count) - now()); });
  }

  // ---------- Жизненный цикл ----------
  applyBrand();
  render();
  load({ quiet: true });
  setInterval(tickCountdown, 1000);
  let lastFull = Date.now();
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - fetchedAt > 60000) load(); else if (Date.now() - lastFull > 30000) { lastFull = Date.now(); render(); }
  }, 15000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
  window.addEventListener('online', () => load());
  window.addEventListener('offline', () => { netError = 'Нет интернета'; render(); });
  navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'push') load(); });

  // ---------- Вход по коду (адрес /app/ без токена) ----------
  function entryScreen() {
    const last = LS.get('pt.lastToken', null);
    $('#root').innerHTML = `<div class="entry">
      <h1>Мой тур</h1>
      <p class="sub">Откройте персональную ссылку от турфирмы или введите код из памятки.</p>
      <form id="codeForm"><input id="code" inputmode="text" autocomplete="off" autocapitalize="characters" placeholder="XXXX-XXXX" maxlength="9" aria-label="Код из памятки">
      <div class="err-text" id="codeErr"></div>
      <button class="btn primary block" type="submit">Открыть расписание</button></form>
      ${last ? `<a class="btn block" style="margin-top:12px" href="/t/${esc(last)}/">Открыть мой последний тур</a>` : ''}
    </div>`;
    $('#codeForm').onsubmit = async (ev) => {
      ev.preventDefault();
      const code = $('#code').value.trim();
      $('#codeErr').textContent = '';
      try {
        const r = await api(`/api/code/${encodeURIComponent(code.replace(/[^A-Za-z0-9]/g, ''))}`);
        location.href = `/t/${r.token}/`;
      } catch (e) { $('#codeErr').textContent = e.message; }
    };
  }
})();
