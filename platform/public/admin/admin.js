'use strict';
// Офис турфирмы: группы, расписание, туристы, рассылки, журнал доставки.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const toast = (text, err = false) => {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : '');
    t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), err ? 6000 : 3000);
  };

  let token = LS.get('pt.admin.token', null);
  let me = null;

  async function api(method, path, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let res;
    try {
      res = await fetch('/api' + path, {
        method, signal: ctl.signal, cache: 'no-store',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'Сервер не отвечает, попробуйте ещё раз' : 'Нет соединения с сервером');
    } finally { clearTimeout(timer); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path.startsWith('/admin')) { token = null; LS.del('pt.admin.token'); me = null; renderLogin(); throw new Error(data.error || 'Требуется вход'); }
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
  }
  const run = async (fn, btn) => {
    if (btn) btn.disabled = true;
    try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
  };

  // ---------- Справочники ----------
  const LEAD_OPTS = [[0, 'в момент'], [10, '10 мин'], [15, '15 мин'], [30, '30 мин'], [60, '1 ч'], [120, '2 ч'], [180, '3 ч'], [300, '5 ч'], [720, '12 ч'], [1440, '1 день'], [2880, '2 дня']];
  const leadLabel = (m) => (LEAD_OPTS.find((x) => x[0] === m) || [0, m < 60 ? `${m} мин` : m % 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : `${m / 60} ч`])[1];
  const POPULAR_TZ = ['Europe/Moscow', 'Europe/Istanbul', 'Asia/Dubai', 'Africa/Cairo', 'Asia/Bangkok', 'Asia/Ho_Chi_Minh', 'Asia/Shanghai', 'Indian/Maldives', 'Asia/Colombo', 'Asia/Makassar', 'Asia/Tbilisi', 'Asia/Yerevan', 'Asia/Baku', 'Asia/Almaty', 'Asia/Tashkent', 'Europe/Minsk', 'Europe/Kaliningrad', 'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Novosibirsk', 'Asia/Irkutsk', 'Asia/Vladivostok', 'Europe/Athens', 'Europe/Rome', 'Europe/Paris', 'Europe/Madrid', 'Europe/Berlin', 'Asia/Nicosia', 'Africa/Tunis', 'America/Havana', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Kolkata', 'Indian/Mahe', 'Indian/Mauritius', 'Africa/Dar_es_Salaam', 'America/Santo_Domingo', 'America/Cancun', 'UTC'];
  let allTz = POPULAR_TZ;
  try { allTz = Intl.supportedValuesOf('timeZone'); } catch { /* старый браузер */ }
  const tzOptions = (sel, labels = {}) => {
    const pop = POPULAR_TZ.filter((z) => allTz.includes(z) || z === 'UTC');
    const opt = (z) => `<option value="${esc(z)}" ${z === sel ? 'selected' : ''}>${esc(tzName(z, labels))}</option>`;
    return `<optgroup label="Популярные">${pop.map(opt).join('')}</optgroup><optgroup label="Все пояса">${allTz.filter((z) => !pop.includes(z)).map(opt).join('')}</optgroup>`;
  };
  const tzOffset = (tz) => {
    try {
      const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(Date.now()).find((x) => x.type === 'timeZoneName');
      return p ? p.value.replace('GMT', 'UTC') : '';
    } catch { return ''; }
  };
  const TZ_RU = { 'Europe/Moscow': 'Москва', 'Europe/Istanbul': 'Турция', 'Asia/Dubai': 'ОАЭ', 'Africa/Cairo': 'Египет', 'Asia/Bangkok': 'Таиланд', 'Asia/Ho_Chi_Minh': 'Вьетнам', 'Asia/Shanghai': 'Китай', 'Indian/Maldives': 'Мальдивы', 'Asia/Colombo': 'Шри-Ланка', 'Asia/Makassar': 'Бали', 'Asia/Tbilisi': 'Грузия', 'Asia/Yerevan': 'Армения', 'Asia/Baku': 'Азербайджан', 'Asia/Almaty': 'Казахстан (Алматы)', 'Asia/Tashkent': 'Узбекистан', 'Europe/Minsk': 'Беларусь', 'Europe/Kaliningrad': 'Калининград', 'Europe/Samara': 'Самара', 'Asia/Yekaterinburg': 'Екатеринбург', 'Asia/Novosibirsk': 'Новосибирск', 'Asia/Irkutsk': 'Иркутск', 'Asia/Vladivostok': 'Владивосток', 'Europe/Athens': 'Греция', 'Europe/Rome': 'Италия', 'Europe/Paris': 'Франция', 'Europe/Madrid': 'Испания', 'Europe/Berlin': 'Германия', 'Asia/Nicosia': 'Кипр', 'Africa/Tunis': 'Тунис', 'America/Havana': 'Куба', 'Asia/Seoul': 'Корея', 'Asia/Tokyo': 'Япония', 'Asia/Kolkata': 'Индия', 'Indian/Mahe': 'Сейшелы', 'Indian/Mauritius': 'Маврикий', 'Africa/Dar_es_Salaam': 'Танзания (Занзибар)', 'America/Santo_Domingo': 'Доминикана', 'America/Cancun': 'Мексика (Канкун)', UTC: 'UTC' };
  const tzName = (z, labels = {}) => `${TZ_RU[z] || labels[z] || z.replace(/_/g, ' ')} (${tzOffset(z)})`;
  const tzShort = (z, labels = {}) => TZ_RU[z] || labels[z] || z.split('/').pop().replace(/_/g, ' ');

  const fmtDay = (date) => { const [y, m, d] = date.split('-').map(Number); return new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long' }).format(Date.UTC(y, m - 1, d)); };
  const fmtDate = (date) => { const [y, m, d] = date.split('-').map(Number); return new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(Date.UTC(y, m - 1, d)); };
  const fmtDT = (ms) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ms);
  const addDays = (date, n) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const ago = (ms) => { if (!ms) return 'никогда'; const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'только что' : m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.round(m / 60)} ч назад` : fmtDT(ms); };
  const tourLink = (t) => `${location.origin}/t/${t}/`;

  function qrImg(text, cell = 6) {
    try {
      const q = qrcode(0, 'M');
      q.addData(text);
      q.make();
      return q.createDataURL(cell, 2);
    } catch { return ''; }
  }

  // ---------- Модальные окна ----------
  function modal(html, onMount) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const bg = $('.modal-bg', root);
    const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    bg.addEventListener('mousedown', (e) => { if (e.target === bg) close(); });
    $$('[data-close]', root).forEach((b) => b.addEventListener('click', close));
    onMount && onMount($('.modal', root), close);
    const first = $('input,select,textarea', root);
    if (first) setTimeout(() => first.focus(), 30);
    return close;
  }
  const confirmBox = (text, okText = 'Да') => new Promise((resolve) => {
    modal(`<h2>${esc(text)}</h2><div class="foot"><div class="r"><button class="btn" data-close>Отмена</button><button class="btn primary" id="ok">${esc(okText)}</button></div></div>`,
      (m, close) => { $('#ok', m).onclick = () => { close(); resolve(true); }; $$('[data-close]', m).forEach((b) => b.addEventListener('click', () => resolve(false))); });
  });

  // ---------- Вход и первичная настройка ----------
  function renderLogin() {
    $('#modal-root').innerHTML = '';
    $('#app').innerHTML = `<div class="login"><div class="card">
      <h1 style="margin-bottom:6px">Пульс Тур</h1><p class="muted" style="margin-bottom:18px">Вход для сотрудников турфирмы</p>
      <form id="lf"><label class="f"><span>E-mail</span><input type="email" id="le" autocomplete="username" required></label>
      <label class="f"><span>Пароль</span><input type="password" id="lp" autocomplete="current-password" required></label>
      <div class="err" id="lerr"></div><button class="btn primary" style="width:100%;justify-content:center" type="submit">Войти</button></form>
      <p class="small muted" style="margin-top:16px">Первый запуск? <button class="link" id="setupLink">Создать агентство</button></p>
    </div></div>`;
    $('#lf').onsubmit = async (e) => {
      e.preventDefault();
      $('#lerr').textContent = '';
      try {
        const r = await api('POST', '/auth/login', { email: $('#le').value, password: $('#lp').value });
        token = r.token; LS.set('pt.admin.token', token);
        await boot();
      } catch (err) { $('#lerr').textContent = err.message; }
    };
    $('#setupLink').onclick = renderSetup;
  }

  function renderSetup() {
    $('#app').innerHTML = `<div class="login"><div class="card">
      <h1 style="margin-bottom:6px">Новое агентство</h1>
      <p class="muted small" style="margin-bottom:16px">Нужен ключ настройки (SETUP_KEY) — он задаётся на сервере при установке.</p>
      <form id="sf">
        <label class="f"><span>Ключ настройки</span><input type="password" id="sk" required></label>
        <label class="f"><span>Название турфирмы</span><input type="text" id="sa" required maxlength="120"></label>
        <label class="f"><span>Ваше имя</span><input type="text" id="sn" maxlength="120"></label>
        <label class="f"><span>E-mail</span><input type="email" id="se" required></label>
        <label class="f"><span>Пароль (минимум 8 символов)</span><input type="password" id="sp" minlength="8" required autocomplete="new-password"></label>
        <div class="err" id="serr"></div>
        <button class="btn primary" style="width:100%;justify-content:center" type="submit">Создать</button>
      </form><p class="small" style="margin-top:14px"><button class="link" id="back">← Ко входу</button></p></div></div>`;
    $('#back').onclick = renderLogin;
    $('#sf').onsubmit = async (e) => {
      e.preventDefault();
      $('#serr').textContent = '';
      try {
        await api('POST', '/auth/setup', { setupKey: $('#sk').value, agencyName: $('#sa').value, name: $('#sn').value, email: $('#se').value, password: $('#sp').value });
        const r = await api('POST', '/auth/login', { email: $('#se').value, password: $('#sp').value });
        token = r.token; LS.set('pt.admin.token', token);
        await boot();
      } catch (err) { $('#serr').textContent = err.message; }
    };
  }

  // ---------- Каркас ----------
  function shell(content) {
    const sys = me.system;
    const lag = sys.lastDispatchAt ? Date.now() - sys.lastDispatchAt : Infinity;
    const okSched = lag < 3 * 60000;
    const warns = [];
    if (!okSched) warns.push(`Планировщик уведомлений не запускался ${sys.lastDispatchAt ? ago(sys.lastDispatchAt) : 'ни разу'} — проверьте cron в Cloudflare.`);
    if (!sys.push) warns.push('Не заданы VAPID-ключи: push-уведомления в браузере работать не будут.');
    if (!sys.telegram) warns.push('Telegram-бот не настроен — туристам будет недоступен самый надёжный канал.');
    $('#app').innerHTML = `
      <div class="topbar"><span class="brand" id="home">${esc(me.agency.name)}</span>
        <span class="health" title="Последний запуск планировщика: ${esc(ago(sys.lastDispatchAt))}"><span class="dot ${okSched ? 'ok' : 'bad'}"></span>${okSched ? 'Уведомления работают' : 'Планировщик не отвечает'}</span>
        <span class="sp"></span>
        <a class="btn sm" href="#/settings">⚙️ Настройки</a>
        <button class="btn sm" id="logout">Выйти</button></div>
      <main>${warns.length ? `<div class="note warn" style="margin-bottom:16px">${warns.map(esc).join('<br>')}</div>` : ''}${content}</main>`;
    $('#home').onclick = () => { location.hash = '#/'; };
    $('#logout').onclick = async () => { await api('POST', '/admin/logout').catch(() => {}); token = null; LS.del('pt.admin.token'); renderLogin(); };
  }

  async function boot() {
    if (!token) return renderLogin();
    try { me = await api('GET', '/admin/me'); } catch { return; }
    document.documentElement.style.setProperty('--accent', me.agency.brand_color || '#6366f1');
    route();
  }
  window.addEventListener('hashchange', () => { if (me) route(); });
  setInterval(async () => { if (me && document.visibilityState === 'visible') { try { me = await api('GET', '/admin/me'); } catch { /* сеть */ } } }, 120000);

  function route() {
    $('#modal-root').innerHTML = '';
    const h = location.hash.replace(/^#\/?/, '').split('/');
    if (h[0] === 'g' && h[1]) return groupPage(h[1], h[2] || 'schedule');
    if (h[0] === 'settings') return settingsPage();
    return groupsPage(h[0] === 'archive');
  }

  // ---------- Список групп ----------
  async function groupsPage(archived) {
    shell('<div class="muted">Загрузка…</div>');
    const r = await run(() => api('GET', `/admin/groups${archived ? '?archived=1' : ''}`));
    if (!r) return;
    shell(`<div class="head"><div><h1>${archived ? 'Архив' : 'Группы и заезды'}</h1>
        <p class="muted">${archived ? 'Завершённые туры. Уведомления не отправляются.' : 'Каждая группа — конкретный заезд со своими датами, расписанием и туристами.'}</p></div>
      <div class="actions"><a class="btn" href="${archived ? '#/' : '#/archive'}">${archived ? '← Активные' : '🗄 Архив'}</a>${archived ? '' : '<button class="btn primary" id="newG">+ Новая группа</button>'}</div></div>
      ${r.groups.length ? `<div class="grid">${r.groups.map((g) => `<div class="card gcard" data-id="${esc(g.id)}">
        <h3>${esc(g.title)}</h3><div class="muted small">${esc(fmtDate(g.start_date))} — ${esc(fmtDate(g.end_date))} · ${esc(tzShort(g.tz))}</div>
        <div class="stats"><span>Событий: <b>${g.events}</b></span><span>Туристов: <b>${g.participants}</b></span>
        <span>С уведомлениями: <b>${g.connected}</b>${g.participants && g.connected < g.participants ? ' <span class="pill warn">не все</span>' : ''}</span></div></div>`).join('')}</div>`
        : `<div class="card"><p>${archived ? 'Архив пуст.' : 'Групп пока нет. Создайте первую — например, «Стамбул 12–17 мая».'}</p></div>`}`);
    $$('.gcard').forEach((c) => c.addEventListener('click', () => { location.hash = `#/g/${c.dataset.id}`; }));
    const nb = $('#newG'); if (nb) nb.onclick = () => groupForm(null);
  }

  function groupForm(g) {
    const today = new Date().toISOString().slice(0, 10);
    modal(`<h2>${g ? 'Параметры группы' : 'Новая группа'}</h2><form id="gf">
      <label class="f"><span>Название</span><input type="text" name="title" required maxlength="150" value="${esc(g?.title || '')}" placeholder="Стамбул 12–17 мая"></label>
      <div class="row"><label class="f"><span>Начало</span><input type="date" name="start_date" required value="${esc(g?.start_date || today)}"></label>
      <label class="f"><span>Окончание</span><input type="date" name="end_date" required value="${esc(g?.end_date || addDays(today, 6))}"></label></div>
      <div class="row"><label class="f"><span>Часовой пояс места отдыха</span><select name="tz">${tzOptions(g?.tz || 'Europe/Istanbul')}</select></label>
      <label class="f"><span>Откуда туристы (домашнее время)</span><select name="home_tz">${tzOptions(g?.home_tz || 'Europe/Moscow')}</select></label></div>
      <div class="row"><label class="f"><span>Гид / сопровождающий</span><input type="text" name="guide_name" maxlength="120" value="${esc(g?.guide_name || '')}"></label>
      <label class="f"><span>Телефон гида</span><input type="tel" name="guide_phone" maxlength="40" value="${esc(g?.guide_phone || '')}"></label></div>
      <label class="f"><span>Памятка туристу (документы, валюта, правила отеля…)</span><textarea name="notes" maxlength="5000">${esc(g?.notes || '')}</textarea></label>
      <div class="err" id="gerr"></div>
      <div class="foot"><div class="r"><button type="button" class="btn" data-close>Отмена</button><button class="btn primary" type="submit">${g ? 'Сохранить' : 'Создать'}</button></div></div></form>`,
    (m, close) => {
      $('#gf', m).onsubmit = async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(e.target));
        try {
          if (g) { await api('PATCH', `/admin/groups/${g.id}`, body); close(); route(); }
          else { const r = await api('POST', '/admin/groups', body); close(); location.hash = `#/g/${r.id}`; }
        } catch (err) { $('#gerr', m).textContent = err.message; }
      };
    });
  }

  // ---------- Страница группы ----------
  let G = null; // { group, events, participants, tzLabels }

  async function groupPage(id, tab) {
    if (!G || G.group.id !== id) shell('<div class="muted">Загрузка…</div>');
    const r = await run(() => api('GET', `/admin/groups/${id}`));
    if (!r) { location.hash = '#/'; return; }
    G = r;
    const g = G.group;
    const connected = G.participants.filter((p) => !p.revoked && (p.webpush || p.telegram)).length;
    const active = G.participants.filter((p) => !p.revoked).length;
    const tabs = [['schedule', 'Расписание'], ['people', `Туристы (${active})`], ['broadcast', 'Сообщение группе'], ['log', 'Журнал уведомлений']];
    shell(`<div class="head"><div><a href="#/" class="small">← Все группы</a><h1>${esc(g.title)} ${g.archived ? '<span class="pill">архив</span>' : ''}</h1>
        <p class="muted">${esc(fmtDate(g.start_date))} — ${esc(fmtDate(g.end_date))} · время: ${esc(tzName(g.tz, G.tzLabels))} · с уведомлениями ${connected} из ${active}</p></div>
      <div class="actions"><button class="btn" id="editG">✏️ Параметры</button><button class="btn" id="copyG">📋 Копировать на новые даты</button>
        <button class="btn" id="archG">${g.archived ? '↩️ Из архива' : '🗄 В архив'}</button><button class="btn danger" id="delG">Удалить</button></div></div>
      <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${k === tab ? 'on' : ''}" data-tab="${k}">${esc(l)}</button>`).join('')}</div>
      <div id="tabBody"></div>`);
    $$('.tab').forEach((b) => b.addEventListener('click', () => { location.hash = `#/g/${g.id}/${b.dataset.tab}`; }));
    $('#editG').onclick = () => groupForm(g);
    $('#copyG').onclick = () => copyForm(g);
    $('#archG').onclick = (e) => run(async () => { await api('PATCH', `/admin/groups/${g.id}`, { archived: !g.archived }); toast(g.archived ? 'Группа снова активна' : 'Группа в архиве, уведомления остановлены'); route(); }, e.target);
    $('#delG').onclick = async () => {
      if (!(await confirmBox(`Удалить группу «${g.title}» со всеми событиями и туристами? Ссылки туристов перестанут работать.`, 'Удалить'))) return;
      await run(async () => { await api('DELETE', `/admin/groups/${g.id}`); toast('Группа удалена'); location.hash = '#/'; });
    };
    ({ schedule: scheduleTab, people: peopleTab, broadcast: broadcastTab, log: logTab }[tab] || scheduleTab)($('#tabBody'));
  }

  function copyForm(g) {
    modal(`<h2>Копировать программу</h2><p class="muted" style="margin-bottom:14px">Все события перенесутся на новые даты с тем же временем. Туристы не копируются.</p>
      <form id="cf"><label class="f"><span>Название новой группы</span><input type="text" name="title" maxlength="150" value="${esc(g.title)}"></label>
      <label class="f"><span>Дата начала нового заезда</span><input type="date" name="start_date" required></label>
      <div class="err" id="cerr"></div><div class="foot"><div class="r"><button type="button" class="btn" data-close>Отмена</button><button class="btn primary">Копировать</button></div></div></form>`,
    (m, close) => {
      $('#cf', m).onsubmit = async (e) => {
        e.preventDefault();
        try { const r = await api('POST', `/admin/groups/${g.id}/copy`, Object.fromEntries(new FormData(e.target))); close(); toast('Группа создана'); location.hash = `#/g/${r.id}`; }
        catch (err) { $('#cerr', m).textContent = err.message; }
      };
    });
  }

  // ----- Расписание -----
  function scheduleTab(el) {
    const g = G.group;
    const byDay = new Map();
    for (let d = g.start_date; d <= g.end_date; d = addDays(d, 1)) byDay.set(d, []);
    for (const e of G.events) { if (!byDay.has(e.local_date)) byDay.set(e.local_date, []); byDay.get(e.local_date).push(e); }
    const days = [...byDay.keys()].sort();
    const types = me.eventTypes;
    const name = (id) => G.participants.find((p) => p.id === id)?.name || 'турист';
    el.innerHTML = `<div class="actions" style="margin-bottom:14px"><button class="btn primary" id="addEv">+ Событие</button>
      <span class="muted small" style="align-self:center">Время вводится местное — как в программе тура. Напоминания туристам рассчитываются автоматически.</span></div>
      ${days.map((d) => {
        const n = Math.round((Date.parse(d) - Date.parse(g.start_date)) / 86400000) + 1;
        const inTour = d >= g.start_date && d <= g.end_date;
        return `<div class="day"><div class="day-h"><b>${inTour ? `День ${n}` : 'Вне дат тура'} · ${esc(fmtDay(d))}</b><button class="btn sm" data-add="${d}">+</button></div>
        ${byDay.get(d).map((e) => `<div class="ev ${e.cancelled ? 'cancelled' : ''}" data-ev="${esc(e.id)}">
          <div class="tm">${e.local_time ? esc(e.local_time) : 'весь день'}${e.tz !== g.tz ? `<small>${esc(tzShort(e.tz, G.tzLabels))}</small>` : ''}</div>
          <div><div class="t">${esc(types[e.type]?.icon || '📌')} ${esc(e.title)} ${e.flight_no ? `<span class="pill">${esc(e.flight_no)}</span>` : ''}${e.cancelled ? '<span class="pill bad">отменено</span>' : ''}${e.audience ? `<span class="pill" title="${esc(e.audience.map(name).join(', '))}">👥 ${e.audience.length}</span>` : ''}</div>
            <div class="meta">${esc([e.meeting_point && 'Сбор: ' + e.meeting_point, e.location].filter(Boolean).join(' · '))}</div></div>
          <div class="meta">${e.leads.length ? '🔔 ' + esc(e.leads.map(leadLabel).join(', ')) : '🔕'}</div></div>`).join('') || '<div class="muted small" style="padding:4px 2px">Нет событий</div>'}</div>`;
      }).join('')}`;
    $('#addEv', el).onclick = () => eventForm(null, g.start_date);
    $$('[data-add]', el).forEach((b) => b.addEventListener('click', () => eventForm(null, b.dataset.add)));
    $$('[data-ev]', el).forEach((r) => r.addEventListener('click', () => eventForm(G.events.find((e) => e.id === r.dataset.ev))));
  }

  function eventForm(ev, date) {
    const g = G.group;
    const types = me.eventTypes;
    let type = ev?.type || 'excursion';
    let leads = ev ? [...ev.leads] : [...types[type].leads];
    let leadsTouched = !!ev;
    const people = G.participants.filter((p) => !p.revoked);
    modal(`<h2>${ev ? 'Событие' : 'Новое событие'}</h2><form id="ef">
      <label class="f"><span>Тип</span><div class="chips" id="types">${Object.entries(types).map(([k, t]) => `<button type="button" class="chip ${k === type ? 'on' : ''}" data-type="${k}">${t.icon} ${esc(t.name)}</button>`).join('')}</div></label>
      <label class="f"><span>Название</span><input type="text" name="title" required maxlength="200" value="${esc(ev?.title || '')}" placeholder="Обзорная экскурсия по городу"></label>
      <div class="row3"><label class="f"><span>Дата</span><input type="date" name="local_date" required value="${esc(ev?.local_date || date)}"></label>
        <label class="f"><span>Время</span><input type="time" name="local_time" value="${esc(ev?.local_time || '')}" ${ev && !ev.local_time ? 'disabled' : ''}></label>
        <label class="f"><span>Длительность, мин</span><input type="number" name="duration_min" min="0" max="20160" step="5" value="${esc(ev?.duration_min ?? 60)}"></label></div>
      <label class="check"><input type="checkbox" id="allDay" ${ev && !ev.local_time ? 'checked' : ''}> Весь день (без времени)</label>
      <label class="f"><span>Часовой пояс события</span><select name="tz">${tzOptions(ev?.tz || g.tz, G.tzLabels)}</select>
        <small class="muted">Для вылета из дома укажите пояс аэропорта вылета — время как в билете.</small></label>
      <div id="flightRow" class="row" style="${type === 'flight' ? '' : 'display:none'}"><label class="f"><span>Номер рейса</span><input type="text" name="flight_no" maxlength="20" value="${esc(ev?.flight_no || '')}" placeholder="SU 2134"></label><div></div></div>
      <div class="row"><label class="f"><span>Место сбора</span><input type="text" name="meeting_point" maxlength="200" value="${esc(ev?.meeting_point || '')}" placeholder="Лобби отеля"></label>
        <label class="f"><span>Место / объект</span><input type="text" name="location" maxlength="200" value="${esc(ev?.location || '')}" placeholder="Музей Топкапы"></label></div>
      <div class="row"><label class="f"><span>Адрес</span><input type="text" name="address" maxlength="300" value="${esc(ev?.address || '')}"></label>
        <label class="f"><span>Ссылка на карту</span><input type="url" name="map_url" maxlength="1000" value="${esc(ev?.map_url || '')}" placeholder="https://yandex.ru/maps/…"></label></div>
      <label class="f"><span>Что важно знать (взять с собой, дресс-код…)</span><textarea name="notes" maxlength="3000">${esc(ev?.notes || '')}</textarea></label>
      <label class="f"><span>Напомнить туристам за</span><div class="chips" id="leads"></div><small class="muted">Ночные напоминания (за 6+ ч) автоматически переносятся на 21:00 накануне.</small></label>
      <label class="f"><span>Кому показывать</span>
        <label class="check"><input type="radio" name="aud" value="all" ${!ev?.audience ? 'checked' : ''}> Вся группа</label>
        <label class="check"><input type="radio" name="aud" value="some" ${ev?.audience ? 'checked' : ''} ${people.length ? '' : 'disabled'}> Только выбранным туристам (доп. экскурсия, другой рейс)</label>
        <div id="audList" style="${ev?.audience ? '' : 'display:none'};max-height:160px;overflow:auto;border:1px solid var(--line);border-radius:9px;padding:6px 10px">
          ${people.map((p) => `<label class="check"><input type="checkbox" value="${esc(p.id)}" ${ev?.audience?.includes(p.id) ? 'checked' : ''}> ${esc(p.name || 'Без имени')} <span class="muted small">${esc(p.code)}</span></label>`).join('')}</div></label>
      ${ev ? `<label class="check"><input type="checkbox" id="notify" checked> Сообщить туристам об изменении времени или места</label>` : ''}
      <div class="err" id="eerr"></div>
      <div class="foot">${ev ? `<div class="actions"><button type="button" class="btn danger" id="delEv">Удалить</button>
          <button type="button" class="btn" id="cancelEv">${ev.cancelled ? 'Вернуть в программу' : 'Отменить событие'}</button></div>` : ''}
        <div class="r"><button type="button" class="btn" data-close>Закрыть</button><button class="btn primary" type="submit">Сохранить</button></div></div></form>`,
    (m, close) => {
      const renderLeads = () => {
        const opts = [...new Set([...LEAD_OPTS.map((x) => x[0]), ...leads])].sort((a, b) => a - b);
        $('#leads', m).innerHTML = opts.map((v) => `<button type="button" class="chip ${leads.includes(v) ? 'on' : ''}" data-lead="${v}">${esc(leadLabel(v))}</button>`).join('');
        $$('[data-lead]', m).forEach((b) => b.addEventListener('click', () => {
          const v = Number(b.dataset.lead);
          leadsTouched = true;
          leads = leads.includes(v) ? leads.filter((x) => x !== v) : [...leads, v];
          renderLeads();
        }));
      };
      renderLeads();
      $$('[data-type]', m).forEach((b) => b.addEventListener('click', () => {
        type = b.dataset.type;
        $$('[data-type]', m).forEach((x) => x.classList.toggle('on', x === b));
        $('#flightRow', m).style.display = type === 'flight' ? '' : 'none';
        if (!leadsTouched) { leads = [...types[type].leads]; renderLeads(); }
      }));
      const f = $('#ef', m);
      $('#allDay', m).onchange = (e) => { f.local_time.disabled = e.target.checked; };
      $$('input[name=aud]', m).forEach((r) => r.addEventListener('change', () => { $('#audList', m).style.display = f.aud.value === 'some' ? '' : 'none'; }));
      const collect = () => {
        const fd = Object.fromEntries(new FormData(f));
        const allDay = $('#allDay', m).checked;
        if (!allDay && !fd.local_time) throw new Error('Укажите время или отметьте «Весь день»');
        const audience = f.aud.value === 'some' ? $$('#audList input:checked', m).map((x) => x.value) : null;
        if (audience && !audience.length) throw new Error('Отметьте туристов или выберите «Вся группа»');
        return {
          type, title: fd.title, local_date: fd.local_date, local_time: allDay ? null : fd.local_time, tz: fd.tz,
          duration_min: Number(fd.duration_min || 0), flight_no: type === 'flight' ? fd.flight_no : '',
          meeting_point: fd.meeting_point, location: fd.location, address: fd.address, map_url: fd.map_url, notes: fd.notes,
          leads, audience,
        };
      };
      const save = async (extra = {}) => {
        $('#eerr', m).textContent = '';
        try {
          const body = { ...collect(), ...extra };
          if (ev) {
            const r = await api('PATCH', `/admin/events/${ev.id}`, { ...body, rev: ev.rev, notify: $('#notify', m).checked });
            toast(r.notified ? 'Сохранено, туристы получили уведомление об изменении' : 'Сохранено');
          } else {
            await api('POST', `/admin/groups/${G.group.id}/events`, body);
            toast('Событие добавлено');
          }
          close(); route();
        } catch (err) { $('#eerr', m).textContent = err.message; }
      };
      f.onsubmit = (e) => { e.preventDefault(); save(); };
      if (ev) {
        $('#cancelEv', m).onclick = () => save({ cancelled: !ev.cancelled });
        $('#delEv', m).onclick = async () => {
          close();
          if (!(await confirmBox(`Удалить «${ev.title}» без уведомления туристов? Чтобы предупредить их, используйте «Отменить событие».`, 'Удалить'))) return;
          await run(async () => { await api('DELETE', `/admin/events/${ev.id}`); toast('Удалено'); route(); });
        };
      }
    });
  }

  // ----- Туристы -----
  function peopleTab(el) {
    const ps = G.participants;
    el.innerHTML = `<div class="card" style="margin-bottom:16px"><h3 style="margin-bottom:8px">Добавить туристов</h3>
        <div class="row"><label class="f"><span>Имена — по одному в строке (можно вставить из Excel)</span><textarea id="names" placeholder="Иванов Иван&#10;Петрова Мария"></textarea></label>
        <div><p class="muted small" style="margin-bottom:8px">Каждый турист получит личную ссылку и код. Имена не обязательны: можно создать нужное количество «мест» и раздать ссылки.</p>
        <div class="actions"><button class="btn primary" id="addNames">Добавить по именам</button></div>
        <div class="actions" style="margin-top:8px"><input type="number" id="cnt" min="1" max="200" value="10" style="width:90px"><button class="btn" id="addCnt">Добавить без имён</button></div></div></div></div>
      <div class="actions" style="margin-bottom:12px"><button class="btn" id="printAll" ${ps.length ? '' : 'disabled'}>🖨 Распечатать памятки с QR-кодами</button>
        <button class="btn" id="copyAll" ${ps.length ? '' : 'disabled'}>📋 Скопировать все ссылки</button></div>
      ${ps.length ? `<table><thead><tr><th>Турист</th><th>Код</th><th>Уведомления</th><th>Заходил</th><th></th></tr></thead><tbody>
        ${ps.map((p) => `<tr ${p.revoked ? 'style="opacity:.5"' : ''}><td>${esc(p.name || '—')}${p.revoked ? ' <span class="pill bad">отключён</span>' : ''}</td>
          <td><code>${esc(p.code)}</code></td>
          <td>${p.webpush ? `<span class="pill ok">🔔 браузер${p.webpush > 1 ? ' ×' + p.webpush : ''}</span>` : ''}${p.telegram ? '<span class="pill ok">✈️ Telegram</span>' : ''}${!p.webpush && !p.telegram ? '<span class="pill warn">не подключены</span>' : ''}</td>
          <td class="small muted">${esc(ago(p.last_seen_at))}</td>
          <td style="white-space:nowrap"><button class="btn sm" data-qr="${esc(p.id)}">Ссылка / QR</button> <button class="btn sm" data-more="${esc(p.id)}">⋯</button></td></tr>`).join('')}</tbody></table>`
        : '<div class="card muted">Туристов пока нет.</div>'}`;
    const add = (body, btn) => run(async () => { const r = await api('POST', `/admin/groups/${G.group.id}/participants`, body); toast(`Добавлено: ${r.added}`); route(); }, btn);
    $('#addNames', el).onclick = (e) => {
      const names = $('#names', el).value.split(/\r?\n/).map((s) => s.split('\t')[0].trim()).filter(Boolean);
      if (!names.length) return toast('Введите хотя бы одно имя', true);
      add({ names }, e.target);
    };
    $('#addCnt', el).onclick = (e) => add({ count: Number($('#cnt', el).value) }, e.target);
    $('#printAll', el).onclick = () => printCards(ps.filter((p) => !p.revoked));
    $('#copyAll', el).onclick = () => copyText(ps.filter((p) => !p.revoked).map((p) => `${p.name || 'Турист'} — ${tourLink(p.token)} (код ${p.code})`).join('\n'), 'Ссылки скопированы');
    $$('[data-qr]', el).forEach((b) => b.addEventListener('click', () => qrModal(ps.find((p) => p.id === b.dataset.qr))));
    $$('[data-more]', el).forEach((b) => b.addEventListener('click', () => personModal(ps.find((p) => p.id === b.dataset.more))));
  }

  async function copyText(text, ok = 'Скопировано') {
    try { await navigator.clipboard.writeText(text); toast(ok); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast(ok); } catch { toast('Не удалось скопировать', true); }
      ta.remove();
    }
  }

  function inviteText(p) {
    return `Здравствуйте${p.name ? ', ' + p.name : ''}! Ваше расписание тура «${G.group.title}» с напоминаниями: ${tourLink(p.token)}\nКод для входа: ${p.code}`;
  }

  function qrModal(p) {
    const url = tourLink(p.token);
    const wa = `https://wa.me/?text=${encodeURIComponent(inviteText(p))}`;
    const tg = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(`Расписание тура «${G.group.title}». Код: ${p.code}`)}`;
    modal(`<h2>${esc(p.name || 'Турист')}</h2><div class="qr-box">
      <img alt="QR-код ссылки" src="${qrImg(url)}"><div>Код: <code style="font-size:18px;font-weight:700">${esc(p.code)}</code></div>
      <div class="linkbox"><input type="text" readonly value="${esc(url)}"><button class="btn" id="cp">Копировать</button></div>
      <div class="actions"><button class="btn" id="cpMsg">📋 Текст приглашения</button><a class="btn" href="${esc(wa)}" target="_blank" rel="noopener">WhatsApp</a><a class="btn" href="${esc(tg)}" target="_blank" rel="noopener">Telegram</a><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">👁 Открыть как турист</a></div>
      <p class="muted small">Ссылка личная: по ней турист видит только своё расписание.</p></div>
      <div class="foot"><div class="r"><button class="btn" data-close>Готово</button></div></div>`, (m) => {
      $('#cp', m).onclick = () => copyText(url, 'Ссылка скопирована');
      $('#cpMsg', m).onclick = () => copyText(inviteText(p), 'Текст скопирован');
    });
  }

  function personModal(p) {
    modal(`<h2>Турист</h2><label class="f"><span>Имя</span><input type="text" id="pn" maxlength="120" value="${esc(p.name)}"></label>
      <div class="actions" style="margin:6px 0 4px"><button class="btn" id="saveName">Сохранить имя</button>
        <button class="btn" id="regen">🔄 Выдать новую ссылку</button>
        <button class="btn" id="toggle">${p.revoked ? '✅ Включить доступ' : '⛔ Отключить доступ'}</button>
        <button class="btn danger" id="delP">Удалить</button></div>
      <p class="muted small">Новая ссылка нужна, если старая попала к посторонним: старая перестанет работать, уведомления придётся включить заново.</p>
      <div class="foot"><div class="r"><button class="btn" data-close>Закрыть</button></div></div>`, (m, close) => {
      const patch = (body, msg, btn) => run(async () => { await api('PATCH', `/admin/participants/${p.id}`, body); toast(msg); close(); route(); }, btn);
      $('#saveName', m).onclick = (e) => patch({ name: $('#pn', m).value }, 'Сохранено', e.target);
      $('#toggle', m).onclick = (e) => patch({ revoked: !p.revoked }, p.revoked ? 'Доступ включён' : 'Доступ отключён', e.target);
      $('#regen', m).onclick = async () => { close(); if (await confirmBox('Выдать новую ссылку? Старая перестанет работать.', 'Выдать')) patch({ regenerate: true }, 'Новая ссылка создана'); };
      $('#delP', m).onclick = async () => { close(); if (await confirmBox(`Удалить туриста «${p.name || p.code}»?`, 'Удалить')) await run(async () => { await api('DELETE', `/admin/participants/${p.id}`); toast('Удалено'); route(); }); };
    });
  }

  function printCards(ps) {
    document.querySelector('.print-sheet')?.remove();
    const sheet = document.createElement('div');
    sheet.className = 'print-sheet';
    sheet.innerHTML = ps.map((p) => `<div class="print-card"><b>${esc(me.agency.name)}</b><div>${esc(G.group.title)}</div>
      <div style="margin:3mm 0">${esc(p.name || '')}</div><img alt="" src="${qrImg(tourLink(p.token), 5)}">
      <div>Наведите камеру телефона на QR-код,<br>чтобы открыть расписание с напоминаниями</div>
      <div style="margin-top:2mm">или откройте <b>${esc(location.host)}/app</b> и введите код</div><div class="code">${esc(p.code)}</div></div>`).join('');
    document.body.appendChild(sheet);
    setTimeout(() => window.print(), 100);
  }

  // ----- Сообщение группе -----
  function broadcastTab(el) {
    const people = G.participants.filter((p) => !p.revoked);
    el.innerHTML = `<div class="card" style="max-width:640px"><h3 style="margin-bottom:6px">Срочное сообщение</h3>
      <p class="muted small" style="margin-bottom:12px">Уйдёт сразу во все подключённые каналы: уведомления браузера и Telegram. Например: «Автобус задерживается на 15 минут».</p>
      <label class="f"><span>Текст</span><textarea id="btext" maxlength="900"></textarea></label>
      <label class="check"><input type="radio" name="baud" value="all" checked> Вся группа (${people.length})</label>
      <label class="check"><input type="radio" name="baud" value="some"> Выбрать туристов</label>
      <div id="baudList" style="display:none;max-height:180px;overflow:auto;border:1px solid var(--line);border-radius:9px;padding:6px 10px">
        ${people.map((p) => `<label class="check"><input type="checkbox" value="${esc(p.id)}"> ${esc(p.name || 'Без имени')} <span class="muted small">${esc(p.code)}</span></label>`).join('')}</div>
      <div class="actions" style="margin-top:12px"><button class="btn primary" id="bsend">Отправить</button></div></div>`;
    $$('input[name=baud]', el).forEach((r) => r.addEventListener('change', () => { $('#baudList', el).style.display = r.value === 'some' && r.checked ? '' : 'none'; }));
    $('#bsend', el).onclick = (e) => {
      const text = $('#btext', el).value.trim();
      if (!text) return toast('Введите текст', true);
      const some = $('input[name=baud]:checked', el).value === 'some';
      const audience = some ? $$('#baudList input:checked', el).map((x) => x.value) : null;
      if (some && !audience.length) return toast('Отметьте получателей', true);
      run(async () => {
        const r = await api('POST', `/admin/groups/${G.group.id}/broadcast`, { text, audience });
        toast(`Отправлено: ${r.stats.sent}${r.stats.retried ? `, повторим: ${r.stats.retried}` : ''}`);
        $('#btext', el).value = '';
      }, e.target);
    };
  }

  // ----- Журнал -----
  async function logTab(el) {
    el.innerHTML = '<div class="muted">Загрузка…</div>';
    const r = await run(() => api('GET', `/admin/groups/${G.group.id}/notifications`));
    if (!r) return;
    const kinds = { reminder: 'Напоминание', change: 'Изменение', cancel: 'Отмена', broadcast: 'Сообщение', test: 'Проверка' };
    const now = Date.now();
    el.innerHTML = `<p class="muted small" style="margin-bottom:10px">Запланированные и отправленные уведомления. «Доставлено» — принято сервисом уведомлений (браузер) или Telegram.</p>
      ${r.notifications.length ? `<table><thead><tr><th>Когда</th><th>Тип</th><th>Текст</th><th>Статус</th></tr></thead><tbody>
      ${r.notifications.map((n) => {
        let st;
        if (n.status === 'pending') st = n.fire_at > now ? '<span class="pill">запланировано</span>' : '<span class="pill warn">в очереди</span>';
        else if (n.status === 'skipped') st = '<span class="pill">пропущено (устарело)</span>';
        else st = `${n.sent ? `<span class="pill ok">доставлено ${n.sent}</span>` : ''}${n.queued ? `<span class="pill warn">отправляется ${n.queued}</span>` : ''}${n.failed ? `<span class="pill bad" title="${esc(n.last_error || '')}">ошибка ${n.failed}</span>` : ''}${!n.sent && !n.queued && !n.failed ? '<span class="pill">нет получателей</span>' : ''}`;
        return `<tr><td class="small" style="white-space:nowrap">${esc(fmtDT(n.fire_at))}</td><td class="small">${esc(kinds[n.kind] || n.kind)}${n.lead_min != null ? `<br><span class="muted">за ${esc(leadLabel(n.lead_min))}</span>` : ''}</td>
          <td><b>${esc(n.title)}</b><div class="small muted">${esc(n.body)}</div></td><td>${st}</td></tr>`;
      }).join('')}</tbody></table>` : '<div class="card muted">Пока пусто. Добавьте события — напоминания появятся здесь.</div>'}`;
  }

  // ---------- Настройки ----------
  async function settingsPage() {
    const owner = me.staff.role === 'owner';
    const staff = owner ? (await run(() => api('GET', '/admin/staff')))?.staff || [] : [];
    const a = me.agency, sys = me.system;
    shell(`<a href="#/" class="small">← Группы</a><h1 style="margin-bottom:16px">Настройки</h1>
      <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(340px,1fr))">
      <div class="card"><h3 style="margin-bottom:12px">Агентство</h3>
        <label class="f"><span>Название (видят туристы)</span><input type="text" id="an" value="${esc(a.name)}" ${owner ? '' : 'disabled'}></label>
        <label class="f"><span>Телефон для экстренной связи</span><input type="tel" id="ap" value="${esc(a.phone)}" ${owner ? '' : 'disabled'}></label>
        <label class="f"><span>Фирменный цвет</span><input type="color" id="ac" value="${esc(a.brand_color)}" ${owner ? '' : 'disabled'}></label>
        ${owner ? '<button class="btn primary" id="saveA">Сохранить</button>' : '<p class="muted small">Изменять может владелец аккаунта.</p>'}</div>
      <div class="card"><h3 style="margin-bottom:12px">Состояние системы</h3>
        <p>Планировщик: ${sys.lastDispatchAt && Date.now() - sys.lastDispatchAt < 180000 ? '<span class="pill ok">работает</span>' : '<span class="pill bad">не отвечает</span>'} <span class="muted small">${esc(ago(sys.lastDispatchAt))}</span></p>
        <p style="margin-top:6px">Push в браузере: ${sys.push ? '<span class="pill ok">настроен</span>' : '<span class="pill bad">нет VAPID-ключей</span>'}</p>
        <p style="margin-top:6px">Telegram-бот: ${sys.telegram ? '<span class="pill ok">настроен</span>' : '<span class="pill warn">не настроен</span>'}</p>
        ${owner && sys.telegram ? '<button class="btn" style="margin-top:12px" id="tgSetup">Переподключить webhook бота</button>' : ''}</div>
      <div class="card"><h3 style="margin-bottom:12px">Смена пароля</h3>
        <label class="f"><span>Текущий пароль</span><input type="password" id="op" autocomplete="current-password"></label>
        <label class="f"><span>Новый пароль</span><input type="password" id="np" autocomplete="new-password" minlength="8"></label>
        <button class="btn" id="savePw">Сменить</button></div>
      ${owner ? `<div class="card"><h3 style="margin-bottom:12px">Сотрудники</h3>
        <table style="margin-bottom:12px"><tbody>${staff.map((s) => `<tr><td>${esc(s.name || s.email)}<div class="small muted">${esc(s.email)} · ${s.role === 'owner' ? 'владелец' : 'менеджер'}</div></td>
          <td style="text-align:right">${s.id !== me.staff.id ? `<button class="btn sm danger" data-del="${esc(s.id)}">Удалить</button>` : ''}</td></tr>`).join('')}</tbody></table>
        <form id="sf"><div class="row"><input type="text" name="name" placeholder="Имя"><input type="email" name="email" placeholder="E-mail" required></div>
        <div class="row" style="margin-top:8px"><input type="password" name="password" placeholder="Пароль (8+)" minlength="8" required autocomplete="new-password">
        <select name="role"><option value="manager">Менеджер</option><option value="owner">Владелец</option></select></div>
        <button class="btn" style="margin-top:8px">Добавить сотрудника</button></form></div>` : ''}
      </div>`);
    if (owner) {
      $('#saveA').onclick = (e) => run(async () => { await api('PATCH', '/admin/agency', { name: $('#an').value, phone: $('#ap').value, brand_color: $('#ac').value }); toast('Сохранено'); await boot(); }, e.target);
      $('#sf').onsubmit = (e) => { e.preventDefault(); run(async () => { await api('POST', '/admin/staff', Object.fromEntries(new FormData(e.target))); toast('Сотрудник добавлен'); settingsPage(); }); };
      $$('[data-del]').forEach((b) => b.addEventListener('click', async () => { if (await confirmBox('Удалить сотрудника?', 'Удалить')) run(async () => { await api('DELETE', `/admin/staff/${b.dataset.del}`); settingsPage(); }); }));
      const tb = $('#tgSetup'); if (tb) tb.onclick = (e) => run(async () => { const r = await api('POST', '/admin/telegram/setup'); toast(r.webhook?.ok ? 'Webhook бота подключён' : 'Ошибка: ' + (r.webhook?.description || 'неизвестно'), !r.webhook?.ok); }, e.target);
    }
    $('#savePw').onclick = (e) => run(async () => { await api('POST', '/admin/password', { oldPassword: $('#op').value, newPassword: $('#np').value }); toast('Пароль изменён'); $('#op').value = $('#np').value = ''; }, e.target);
  }

  boot();
})();
