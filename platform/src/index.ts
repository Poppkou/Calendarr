import { Hono } from 'hono';
import { admin, auth } from './routes/admin';
import { tourist, loadTourist, manifestFor } from './routes/tourist';
import { telegram } from './routes/telegram';
import { cleanup, runDispatch } from './dispatch';
import { askReviews } from './reviews';
import { getMeta, HttpError, type Env } from './util';

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
  console.error('unhandled', c.req.method, c.req.path, err);
  return c.json({ error: 'Внутренняя ошибка сервера. Попробуйте ещё раз.' }, 500);
});
app.notFound((c) => c.json({ error: 'Не найдено' }, 404));

app.use('/api/*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
});

app.get('/api/health', async (c) => {
  const last = await getMeta(c.env.DB, 'last_dispatch_at');
  const lastAt = last ? Number(last) : null;
  const ok = lastAt !== null && Date.now() - lastAt < 3 * 60_000;
  return c.json({ ok, db: true, lastDispatchAt: lastAt, serverTime: Date.now() }, ok ? 200 : 503);
});
app.get('/api/vapid', (c) => c.json({ publicKey: c.env.VAPID_PUBLIC_KEY ?? null }));

app.route('/api/auth', auth);
app.route('/api/admin', admin);
app.route('/api/telegram', telegram);
app.route('/api', tourist);

// Персональная ссылка туриста: /t/<token>/ — отдаём приложение, токен оно возьмёт из адреса.
// Токен в пути (а не в localStorage) нужен для iPhone: иконка на экране «Домой» открывает
// именно этот адрес, а хранилище у неё отдельное от Safari.
app.get('/t/:token', (c) => c.redirect(`/t/${c.req.param('token')}/`, 301));
app.get('/t/:token/', async (c) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL('/app/', c.req.url)));
  const h = new Headers(res.headers);
  h.set('Cache-Control', 'no-cache');
  h.set('Referrer-Policy', 'no-referrer');
  return new Response(res.body, { status: res.status, headers: h });
});
app.get('/t/:token/manifest.webmanifest', async (c) => {
  const token = c.req.param('token');
  const t = await loadTourist(c.env.DB, token);
  return c.body(JSON.stringify(manifestFor(t, token)), 200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' });
});

export default {
  fetch: app.fetch,
  async scheduled(ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    const stats = await runDispatch(env);
    if (stats.claimed || stats.fanned) console.log('dispatch', JSON.stringify(stats));
    // Отзывы — отдельно, чтобы сбой Telegram не мешал напоминаниям.
    ctx.waitUntil(askReviews(env).then((n) => { if (n) console.log('reviews asked', n); }).catch((e) => console.error('reviews', e)));
    if (new Date(ctrl.scheduledTime).getUTCMinutes() === 7) ctx.waitUntil(cleanup(env.DB, Date.now()));
  },
} satisfies ExportedHandler<Env>;

export { app };
