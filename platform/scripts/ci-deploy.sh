#!/usr/bin/env bash
# Деплой «Пульс Тур» из GitHub Actions. Делает всё сам:
#   база D1 (создаёт, если нет) → миграции → ключи VAPID (генерирует один раз) →
#   деплой воркера с секретами → подключение Telegram-бота → проверка, что планировщик работает.
#
# Нужны переменные окружения:
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, SETUP_KEY
# Необязательные: TELEGRAM_BOT_TOKEN, PUBLIC_URL, VAPID_SUBJECT
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="pulse-tour"
WORKER="pulse-tour"
API="https://api.cloudflare.com/client/v4"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
WR="npx --no-install wrangler"

fail() { echo "::error::$1"; echo "❌ $1" >> "$SUMMARY"; exit 1; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const v=JSON.parse(s);console.log(($1)??'')}catch(e){console.log('')}})"; }

# ---------- 1. Проверка настроек ----------
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "Не задан секрет CLOUDFLARE_API_TOKEN (GitHub → Settings → Secrets and variables → Actions)"
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || fail "Не задан секрет CLOUDFLARE_ACCOUNT_ID"
[ -n "${SETUP_KEY:-}" ] || fail "Не задан секрет SETUP_KEY (придумайте пароль от 16 символов — он нужен, чтобы создать агентство)"
[ "${#SETUP_KEY}" -ge 16 ] || fail "SETUP_KEY короче 16 символов"

verify=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/user/tokens/verify" || true)
[ "$(echo "$verify" | json 'v.success')" = "true" ] || fail "Cloudflare не принял CLOUDFLARE_API_TOKEN — проверьте, что токен скопирован полностью и не отозван"
echo "✓ Токен Cloudflare действителен"

# ---------- 2. База данных ----------
db_id=$($WR d1 list --json 2>/dev/null | json "(v.find(d=>d.name==='$DB_NAME')||{}).uuid" || true)
if [ -z "$db_id" ]; then
  echo "Создаю базу $DB_NAME…"
  $WR d1 create "$DB_NAME" >/dev/null || fail "Не удалось создать базу D1. Проверьте, что у токена есть право «D1: Edit»"
  db_id=$($WR d1 list --json | json "(v.find(d=>d.name==='$DB_NAME')||{}).uuid")
fi
[ -n "$db_id" ] || fail "Не удалось получить ID базы D1"
sed -i "s/^database_id = .*/database_id = \"$db_id\"/" wrangler.toml
echo "✓ База D1: $db_id"

$WR d1 migrations apply "$DB_NAME" --remote || fail "Ошибка миграции базы"
echo "✓ Миграции применены"

# ---------- 3. Адрес сайта ----------
if [ -z "${PUBLIC_URL:-}" ]; then
  sub=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" | json 'v.result&&v.result.subdomain')
  [ -n "$sub" ] || fail "У аккаунта нет поддомена workers.dev. Откройте в Cloudflare раздел «Workers & Pages» один раз — он предложит выбрать поддомен."
  PUBLIC_URL="https://$WORKER.$sub.workers.dev"
fi
PUBLIC_URL="${PUBLIC_URL%/}"
echo "✓ Адрес: $PUBLIC_URL"

# ---------- 4. Секреты ----------
SECRETS_FILE="$(mktemp)"
trap 'rm -f "$SECRETS_FILE"' EXIT
# Ключи VAPID создаются только при самом первом деплое. Если воркер уже есть, а список
# секретов получить не удалось, — останавливаемся: перевыпуск ключей отключил бы уведомления у всех туристов.
resp="$(mktemp)"
code=$(curl -sS -o "$resp" -w '%{http_code}' -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "$API/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER/secrets" || echo 000)
if [ "$code" = "200" ]; then
  existing=$(json "v.result.map(s=>s.name).join(' ')" < "$resp")
elif [ "$code" = "404" ]; then
  existing=""   # первый деплой — воркера ещё нет
else
  fail "Не удалось проверить секреты воркера (HTTP $code). Попробуйте запустить деплой ещё раз."
fi
rm -f "$resp"

export SETUP_KEY TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
GEN_VAPID=0
case " $existing " in *" VAPID_PRIVATE_KEY "*) ;; *) GEN_VAPID=1 ;; esac
[ "$GEN_VAPID" = 1 ] && echo "Генерирую ключи уведомлений (один раз, хранятся только в Cloudflare)…"

TG_USERNAME=""
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  TG_USERNAME=$(curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe" | json 'v.ok&&v.result.username')
  [ -n "$TG_USERNAME" ] || fail "Telegram не принял TELEGRAM_BOT_TOKEN — проверьте токен от @BotFather"
  export TELEGRAM_WEBHOOK_SECRET="$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
  echo "✓ Telegram-бот: @$TG_USERNAME"
fi

GEN_VAPID=$GEN_VAPID node --input-type=module -e "
const out = { SETUP_KEY: process.env.SETUP_KEY };
if (process.env.GEN_VAPID === '1') {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
  out.VAPID_PRIVATE_KEY = (await crypto.subtle.exportKey('jwk', kp.privateKey)).d;
  out.VAPID_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('base64url');
}
if (process.env.TELEGRAM_BOT_TOKEN) {
  out.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  out.TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
}
process.stdout.write(JSON.stringify(out));
" > "$SECRETS_FILE"

# ---------- 5. Деплой ----------
VARS=(--var "PUBLIC_URL:$PUBLIC_URL" --var "VAPID_SUBJECT:${VAPID_SUBJECT:-$PUBLIC_URL}")
[ -n "$TG_USERNAME" ] && VARS+=(--var "TELEGRAM_BOT_USERNAME:$TG_USERNAME")
$WR deploy --secrets-file "$SECRETS_FILE" "${VARS[@]}" || fail "Деплой не удался — подробности в логе выше"
echo "✓ Воркер задеплоен"

# ---------- 6. Telegram webhook ----------
if [ -n "$TG_USERNAME" ]; then
  body=$(node -e "console.log(JSON.stringify({url:process.argv[1]+'/api/telegram/webhook',secret_token:process.env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:['message']}))" "$PUBLIC_URL")
  r=$(curl -sS -H 'content-type: application/json' -d "$body" "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook")
  [ "$(echo "$r" | json 'v.ok')" = "true" ] || fail "Не удалось подключить webhook бота: $r"
  curl -sS -o /dev/null -H 'content-type: application/json' "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setMyCommands" \
    -d '{"commands":[{"command":"next","description":"Ближайшие события"},{"command":"today","description":"Расписание на сегодня"},{"command":"stop","description":"Отключить уведомления"}]}'
  echo "✓ Webhook бота подключён"
fi

# ---------- 7. Проверка ----------
echo "Жду первый запуск планировщика (до 3 минут)…"
ok=""
for i in $(seq 1 36); do
  h=$(curl -sS "$PUBLIC_URL/api/health" || true)
  if [ "$(echo "$h" | json 'v.ok')" = "true" ]; then ok=1; break; fi
  sleep 5
done

{
  echo "## ✅ Пульс Тур задеплоен"
  echo ""
  echo "| | |"
  echo "|---|---|"
  echo "| Офис турфирмы | $PUBLIC_URL/admin/ |"
  echo "| Вход для туристов | $PUBLIC_URL/app/ |"
  echo "| Проверка работы | $PUBLIC_URL/api/health |"
  [ -n "$TG_USERNAME" ] && echo "| Telegram-бот | https://t.me/$TG_USERNAME |"
  echo ""
  if [ -n "$ok" ]; then echo "Планировщик уведомлений работает ✓"; else echo "⚠️ Планировщик ещё не отозвался — проверьте $PUBLIC_URL/api/health через пару минут."; fi
  [ -z "$TG_USERNAME" ] && echo "" && echo "Telegram-бот не подключён: добавьте секрет TELEGRAM_BOT_TOKEN и запустите деплой ещё раз."
} >> "$SUMMARY"
echo "Готово: $PUBLIC_URL/admin/"
[ -n "$ok" ] || echo "::warning::Планировщик пока не отозвался — проверьте $PUBLIC_URL/api/health через пару минут"
