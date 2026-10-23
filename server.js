// Запуск: IIKO_LOGIN=Angel IIKO_PASS=... node server.js   (Node 18+, без зависимостей)
// Telegram-бот подключается в приложении: Настройки → Telegram-уведомления
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const HOST = process.env.IIKO_HOST || 'https://neon-takshkent-co.iiko.it';
const LOGIN = process.env.IIKO_LOGIN, PASS = process.env.IIKO_PASS, PORT = process.env.PORT || 3000;
if (!LOGIN || !PASS) { console.error('Задайте IIKO_LOGIN и IIKO_PASS'); process.exit(1); }

let token = null;
async function raw(p, opt) {
  const r = await fetch(HOST + p, opt), t = await r.text();
  if (!r.ok) throw new Error(r.status + ' ' + t.slice(0, 200));
  return t;
}
async function getKey() {
  if (!token) {
    const hash = crypto.createHash('sha1').update(PASS).digest('hex');
    token = (await raw('/resto/api/auth?login=' + encodeURIComponent(LOGIN) + '&pass=' + hash)).trim();
  }
  return token;
}
async function api(p, opt) {
  const go = async () => raw(p + (p.includes('?') ? '&' : '?') + 'key=' + await getKey(), opt);
  try { return await go(); } catch (e) { if (/^40[13]/.test(e.message)) { token = null; return go(); } throw e; }
}
const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
function rows(xml, tag) {
  const out = [], re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g'); let m;
  while ((m = re.exec(xml))) {
    const o = {}; m[1].replace(/<(\w+)>([^<]*)<\/\1>/g, (_, k, v) => { o[k] = unesc(v); }); out.push(o);
  }
  return out;
}
const day = d => d.toISOString().slice(0, 10);
function range(q) {
  const to = q.get('to') || day(new Date(Date.now() + 864e5));
  const from = q.get('from') || day(new Date(Date.now() - 14 * 864e5));
  return { from, to };
}

async function staff(q) {
  const { from, to } = range(q);
  const [emp, roles, att] = await Promise.all([
    api('/resto/api/employees'), api('/resto/api/employees/roles'),
    api(`/resto/api/employees/attendance?from=${from}&to=${to}`)]);
  const roleName = Object.fromEntries(rows(roles, 'role').map(r => [r.id, r.name]));
  const people = {};
  rows(emp, 'employee').forEach(e => {
    people[e.id] = { id: e.id, name: e.name || e.login || e.id, role: roleName[e.mainRoleId] || e.mainRoleCode || '', shifts: [] };
  });
  rows(att, 'attendance').forEach(a => {
    const p = people[a.employeeId]; if (!p) return;
    p.shifts.push({ from: a.dateFrom, to: a.dateTo || null, dept: a.departmentName || '', role: roleName[a.roleId] || '' });
  });
  return Object.values(people).filter(p => p.shifts.length);
}

async function olap(q, t) {
  const { from, to } = range(q);
  const body = {
    reportType: 'SALES', buildSummary: false,
    groupByRowFields: ['OpenDate.Typed', 'OrderNum', 'OpenTime', 'Cashier', 'Department', 'OrderDeleted', 'Storned', ...t.fields],
    aggregateFields: ['DishSumInt', 'DishDiscountSumInt', ...t.aggs],
    filters: { 'OpenDate.Typed': { filterType: 'DateRange', periodType: 'CUSTOM', from: from + 'T00:00:00.000', to: to + 'T00:00:00.000', includeLow: true, includeHigh: false } }
  };
  // без этих фильтров iiko по умолчанию отдаёт только неудалённое — удалений в отчёте просто нет
  body.filters.OrderDeleted = { filterType: 'IncludeValues', values: ['NOT_DELETED', 'DELETED'] };
  if (t.fields.includes('DeletedWithWriteoff'))
    body.filters.DeletedWithWriteoff = { filterType: 'IncludeValues', values: ['NOT_DELETED', 'DELETED_WITH_WRITEOFF', 'DELETED_WITHOUT_WRITEOFF'] };
  const res = JSON.parse(await api('/resto/api/v2/reports/olap', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  return res.data || [];
}
// поле «Время печати блюда»: пусто → блюдо удалили до отправки на кухню (можно переопределить через PRINT_FIELD)
const PRINT = process.env.PRINT_FIELD || 'DishServicePrintTime';
// поле «Касса» (1, 2, 3): если в вашем iiko оно называется иначе, задайте CASH_FIELD
const CASH = process.env.CASH_FIELD || 'CashRegisterName';
// от полного набора полей к минимальному: если iiko не принимает поле, пробуем меньше
const TIERS = [
  { fields: ['TableNum', 'DishName', 'DeletedWithWriteoff', 'AuthUser', 'OrderDiscount.Type', PRINT, CASH], aggs: ['DishAmountInt'] },
  { fields: ['TableNum', 'DishName', 'DeletedWithWriteoff', 'AuthUser', 'OrderDiscount.Type', PRINT], aggs: ['DishAmountInt'] },
  { fields: ['TableNum', 'DishName', 'DeletedWithWriteoff', PRINT], aggs: ['DishAmountInt'] },
  { fields: ['TableNum', 'DishName', 'DeletedWithWriteoff', 'AuthUser', 'OrderDiscount.Type'], aggs: ['DishAmountInt'] },
  { fields: ['TableNum', 'DishName', 'DeletedWithWriteoff'], aggs: ['DishAmountInt'] },
  { fields: [], aggs: [] }
];
const opKey = o => [o.time, o.order, o.type, o.dish, o.qty, o.sum, o.kd].join('|');
async function danger(q) {
  let rows, tier = 0, err;
  for (; tier < TIERS.length; tier++) {
    try { rows = await olap(q, TIERS[tier]); break; } catch (e) { err = e; if (!/^409/.test(e.message)) throw e; }
  }
  if (!rows) throw err;
  const ops = [], f = TIERS[tier].fields, hasPrint = f.includes(PRINT);
  // если время печати пустое у всех удалений, поле бесполезно — ничего не переклассифицируем
  const dels = rows.filter(r => r.DeletedWithWriteoff && r.DeletedWithWriteoff !== 'NOT_DELETED');
  const printUseful = hasPrint && dels.some(r => r[PRINT]);
  rows.forEach(r => {
    const sum = +r.DishSumInt || 0, disc = sum - (+r.DishDiscountSumInt || 0);
    const base = { time: r.OpenTime, order: r.OrderNum, table: r.TableNum || '', dish: r.DishName || '', qty: +r.DishAmountInt || 0,
      reg: r[CASH] || '', cashier: r.Cashier || '—', auth: r.AuthUser || '', dept: r.Department || '', sum, discount: disc, discountName: r['OrderDiscount.Type'] || '', kd: disc };
    const nod = { ...base, discount: 0, discountName: '' };   // у удалений скидку не показываем: это не скидка, а убранная позиция
    const item = r.DeletedWithWriteoff && r.DeletedWithWriteoff !== 'NOT_DELETED';
    const st = r.Storned === true || /^true$/i.test(r.Storned);
    const pv = r[PRINT], empty = pv == null || /^\s*(|null|none|-|—|0|0001-01-01.*|1970-01-01.*)\s*$/i.test(String(pv));
    // «Удаление со списанием» всегда настоящее (блюдо уже готовили), его не прячем; «без списания» с пустой печатью = неотпечатанное
    const unprinted = item && printUseful && empty && /WITHOUT/i.test(r.DeletedWithWriteoff);
    if (unprinted) ops.push({ ...nod, type: 'Удаление', severity: 'low' });
    else if (item) ops.push({ ...nod, type: /WITHOUT/i.test(r.DeletedWithWriteoff) ? 'Удаление без списания' : 'Удаление со списанием', severity: 'high' });
    else if (r.OrderDeleted === 'DELETED') ops.push({ ...nod, type: 'Удалённый заказ', severity: 'high' });
    else if (st) ops.push({ ...nod, type: 'Сторно', severity: 'high' });
    else if (sum > 0 && disc / sum >= 0.3) ops.push({ ...base, type: 'Скидка от 30%', severity: 'mid' });
    else if (disc > 0) ops.push({ ...base, type: 'Скидка', severity: 'mid' });   // любая скидка (10, 15, 20%…) — в списке «Важные»
  });
  ops.sort((a, b) => String(b.time).localeCompare(String(a.time)));
  ops.forEach(o => { o.id = opKey(o); });
  const lack = [];
  if (!f.includes(PRINT)) lack.push('нет времени печати блюда: неотпечатанные удаления не отличить от настоящих');
  if (!f.includes(CASH)) lack.push('нет номера кассы: фильтр по кассам недоступен');
  if (!f.includes('AuthUser')) lack.push('нет данных о том, кто подтвердил, и названия скидки');
  if (!f.includes('DishName')) lack.push('нет стола и блюда');
  const note = lack.length ? 'iiko не принял часть полей отчёта (' + lack.join('; ') + ')' : '';
  const mx = a => a.reduce((m, x) => x > m ? x : m, '');
  const dayK = {}; rows.forEach(r => { const d = String(r['OpenDate.Typed'] || '').slice(0, 10); dayK[d] = (dayK[d] || 0) + 1; });
  const dr = rows.filter(r => (+r.DishSumInt || 0) - (+r.DishDiscountSumInt || 0) > 0), discBy = {};
  dr.forEach(r => { const k = (r.AuthUser || r.Cashier || '—') + (r.AuthUser && r.Cashier && r.AuthUser !== r.Cashier ? ' (касса: ' + r.Cashier + ')' : ''); discBy[k] = (discBy[k] || 0) + 1; });
  const stats = { tier, rows: rows.length, latest: mx(rows.map(r => String(r.OpenTime || ''))), days: dayK, disc: dr.length, discLatest: mx(dr.map(r => String(r.OpenTime || ''))), discBy, from: q.get ? q.get('from') : '', to: q.get ? q.get('to') : '' };
  return { ops, note, stats, ...(q.get && q.get('debug') ? { used: f, sample: rows.filter(r => r.DeletedWithWriteoff && r.DeletedWithWriteoff !== 'NOT_DELETED').slice(0, 15) } : {}) };
}

// состав заказа: что пробили, помимо удалённого блюда
async function order(q) {
  const num = q.get('num'), d = (q.get('date') || '').slice(0, 10), dept = q.get('dept') || '', time = q.get('time') || '';
  if (!num || !/^\d{4}-\d\d-\d\d$/.test(d)) throw new Error('Нужны номер заказа и дата');
  const t0 = new Date(d + 'T12:00:00Z').getTime();
  // бизнес-дата заказа может отличаться от даты открытия (ночные заказы), поэтому берём сутки до и после
  const from = day(new Date(t0 - 864e5)), to = day(new Date(t0 + 2 * 864e5));
  const run = async (fields, useDept) => {
    const filters = {
      'OpenDate.Typed': { filterType: 'DateRange', periodType: 'CUSTOM', from: from + 'T00:00:00.000', to: to + 'T00:00:00.000', includeLow: true, includeHigh: false },
      OrderNum: { filterType: 'IncludeValues', values: [/^\d+$/.test(num) ? +num : num] },   // номер заказа в iiko — число
      OrderDeleted: { filterType: 'IncludeValues', values: ['NOT_DELETED', 'DELETED'] },
      DeletedWithWriteoff: { filterType: 'IncludeValues', values: ['NOT_DELETED', 'DELETED_WITH_WRITEOFF', 'DELETED_WITHOUT_WRITEOFF'] }
    };
    if (useDept) filters.Department = { filterType: 'IncludeValues', values: [dept] };
    const res = JSON.parse(await api('/resto/api/v2/reports/olap', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportType: 'SALES', buildSummary: false, groupByRowFields: ['OrderNum', 'OpenTime', ...fields],
        aggregateFields: ['DishAmountInt', 'DishSumInt', 'DishDiscountSumInt'], filters }) }));
    return res.data || [];
  };
  let data = [], withPrint = true, err;
  search: for (const useDept of dept ? [true, false] : [false])
    for (const f of [['DishName', 'DeletedWithWriteoff', PRINT], ['DishName', 'DeletedWithWriteoff']]) {
      try { const r = await run(f, useDept); withPrint = f.includes(PRINT); if (r.length) { data = r; break search; } }
      catch (e) { err = e; }
    }
  if (!data.length && err) throw err;
  // тот самый чек: совпадает номер, заведение и время открытия
  if (time && data.length) {
    let pick = data.filter(r => r.OpenTime === time);
    if (!pick.length) {
      const T = Date.parse(time); let best = null, bd = Infinity;
      data.forEach(r => { const x = Math.abs(Date.parse(r.OpenTime) - T); if (x < bd) { bd = x; best = r.OpenTime; } });
      if (best && bd < 36e5) pick = data.filter(r => r.OpenTime === best);
    }
    if (pick.length) data = pick;
  }
  const lines = data.map(r => {
    const sum = +r.DishSumInt || 0, del = r.DeletedWithWriteoff && r.DeletedWithWriteoff !== 'NOT_DELETED';
    const state = !del ? 'ok' : /WITHOUT/i.test(r.DeletedWithWriteoff) ? (withPrint && !r[PRINT] ? 'unp' : 'del_wo') : 'del_w';
    return { dish: r.DishName || '', qty: +r.DishAmountInt || 0, sum, disc: del ? 0 : Math.max(0, sum - (+r.DishDiscountSumInt || 0)), state };
  }).sort((a, b) => (a.state !== 'ok') - (b.state !== 'ok'));
  return { lines, total: lines.filter(l => l.state === 'ok').reduce((t, l) => t + l.sum - l.disc, 0) };
}

// ───── Telegram: бот подключается в «Настройках» по токену, подписка через /start ─────
// Переменные нужны только для первого запуска (дальше всё хранится в tg.json): TG_TOKEN, TG_CHAT, TG_SEVERITY=high,mid
// Прочее: TG_POLL_MIN=2 (как часто проверять iiko), STATE_DIR (где хранить файлы)
const DIR = process.env.STATE_DIR || __dirname;
const TG_FILE = path.join(DIR, 'tg.json'), STATE = path.join(DIR, 'tg-sent.json');
const TG_POLL = (+process.env.TG_POLL_MIN || 2) * 60e3;
let tg = { token: '', bot: null, sev: ['high', 'mid'], subs: [], offset: 0 };
try { tg = { ...tg, ...JSON.parse(fs.readFileSync(TG_FILE, 'utf8')) }; }
catch (e) {                                                           // первый запуск: берём из переменных окружения
  tg.token = process.env.TG_TOKEN || '';
  if (process.env.TG_SEVERITY) tg.sev = process.env.TG_SEVERITY.split(',');
  if (process.env.TG_CHAT) tg.subs.push({ id: String(process.env.TG_CHAT), name: 'Из TG_CHAT', username: '' });
}
const saveTg = () => { try { fs.writeFileSync(TG_FILE, JSON.stringify(tg), { mode: 0o600 }); } catch (e) { console.error('TG:', e.message); } };
let sent = null;                                                      // Set ключей уже обработанных операций
try { sent = new Set(JSON.parse(fs.readFileSync(STATE, 'utf8'))); } catch (e) {}
const save = () => { try { fs.writeFileSync(STATE, JSON.stringify([...sent].slice(-5000))); } catch (e) {} };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const money = x => Math.round(x).toLocaleString('ru-RU');
const ICON = { high: '🔴', mid: '🟠', low: '🟡' };
// токен наружу не отдаётся
const tgState = () => ({ connected: !!(tg.token && tg.bot), bot: tg.bot, severity: tg.sev.includes('mid') ? 'mid' : 'high', subs: tg.subs });

async function tgCall(method, payload, tok = tg.token) {
  const r = await fetch(`https://api.telegram.org/bot${tok}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload || {}) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { const e = new Error('TG ' + (j.error_code || r.status) + ' ' + (j.description || '')); e.code = j.error_code; throw e; }
  return j.result;
}
async function tgSend(chat, text) {
  try { await tgCall('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }); return true; }
  catch (e) {
    if (e.code === 403) { tg.subs = tg.subs.filter(s => s.id !== String(chat)); saveTg(); }   // бот заблокирован → убираем подписчика
    console.error('TG:', e.message); return false;
  }
}
const when = t => { const m = String(t).match(/(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)/); return m ? `${m[3]}.${m[2]} · ${m[4]}:${m[5]}` : String(t); };
const where = o => [o.dept, o.reg && (/касс/i.test(o.reg) ? '' : 'касса ') + o.reg].filter(Boolean).join(' · ');
const LINE = '─'.repeat(14);
const card = o => [
  where(o) && `🏪 ${esc(where(o))}`,
  `🧾 Заказ №${esc(o.order)}${o.table ? ' · стол ' + esc(o.table) : ''}`,
  o.dish ? `🍽 ${esc(o.dish)}${o.qty > 1 ? ' ×' + o.qty : ''} — <b>${money(o.sum)} сум</b>` : `💰 ${money(o.sum)} сум`,
  o.discount > 0 && `🏷 Скидка ${money(o.discount)} сум${o.discountName ? ' (' + esc(o.discountName) + ')' : ''}`,
  `👤 ${esc(o.cashier)}${o.auth && o.auth !== o.cashier ? ' · подтвердил ' + esc(o.auth) : ''}`,
  `🕐 ${when(o.time)}`
].filter(Boolean).join('\n');
const fmt = o => `${ICON[o.severity] || '⚪'} <b>${esc(o.type)}</b>\n${LINE}\n${card(o)}`;
const fmtMark = (o, st) => `${st === 'ok' ? '✅ <b>Проверено</b>' : '🔎 <b>Нужно разобраться</b>'} · ${esc(o.type)}\n${LINE}\n${card(o)}`;

// Приём /start и /stop: кто нажал Start, тот получает уведомления
let tgGen = 0;
async function tgUpdates(my) {
  while (my === tgGen && tg.token) {
    try {
      const upd = await tgCall('getUpdates', { offset: tg.offset, timeout: 25, allowed_updates: ['message'] });
      if (my !== tgGen) return;
      for (const x of upd) {
        tg.offset = x.update_id + 1;
        const m = x.message; if (!m || m.chat.type !== 'private') continue;
        const id = String(m.chat.id), t = (m.text || '').trim();
        if (/^\/start/.test(t)) {
          if (!tg.subs.some(s => s.id === id)) tg.subs.push({ id, name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' '), username: m.from.username || '' });
          saveTg(); await tgSend(id, 'Готово. Сюда будут приходить опасные операции. Отписаться: /stop');
        } else if (/^\/stop/.test(t)) {
          tg.subs = tg.subs.filter(s => s.id !== id); saveTg(); await tgSend(id, 'Вы отписались. Чтобы вернуться, нажмите /start');
        }
      }
      if (upd.length) saveTg();
    } catch (e) { if (e.code === 401) { tg.bot = null; saveTg(); console.error('TG: токен больше не действует'); return; } console.error('TG:', e.message); await sleep(5000); }
  }
}
async function tgStart() {
  const my = ++tgGen;
  if (!tg.token) return;
  try {
    if (!tg.bot) { const b = await tgCall('getMe'); tg.bot = { username: b.username, name: b.first_name }; saveTg(); }
    await tgCall('deleteWebhook').catch(() => {});
    tgUpdates(my);
  } catch (e) { console.error('TG:', e.message); }
}

// ───── отметки «проверено / разобраться»: общие для всех, хранятся в marks.json ─────
const MARKS = path.join(DIR, 'marks.json');
let marks = {};
try { marks = JSON.parse(fs.readFileSync(MARKS, 'utf8')); } catch (e) {}
const saveMarks = () => {
  const k = Object.keys(marks); if (k.length > 3000) k.sort((a, b) => String(marks[a].at).localeCompare(String(marks[b].at))).slice(0, k.length - 3000).forEach(x => delete marks[x]);
  try { fs.writeFileSync(MARKS, JSON.stringify(marks)); } catch (e) { console.error('marks:', e.message); }
};
const readBody = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 2e4) { req.destroy(); no(new Error('Слишком большой запрос')); } }); req.on('end', () => { try { ok(d ? JSON.parse(d) : {}); } catch (e) { no(e); } }); });
async function notifyMark(o, st) { if (!(tg.token && tg.bot)) return; for (const x of [...tg.subs]) { await tgSend(x.id, fmtMark(o, st)); await sleep(60); } }

let busy = false;
async function pollTg() {
  if (busy || !(tg.token && tg.bot)) return;
  busy = true;
  try {
    // окно в 2 дня назад, чтобы не потерять операции из-за часовых поясов; дубли отсекает sent
    const q = new URLSearchParams({ from: day(new Date(Date.now() - 2 * 864e5)) });
    const { ops } = await danger(q);
    const all = ops.map(o => [o, opKey(o)]).reverse();   // старые → новые
    const list = all.filter(([o]) => tg.sev.includes(o.severity));
    if (!sent) { sent = new Set(all.map(x => x[1])); save(); console.log('TG: базовая линия, пропущено ' + sent.size + ' старых операций'); return; }
    if (tg.subs.length) for (const [o, k] of list) {
      if (sent.has(k)) continue;
      const text = fmt(o); let ok = 0;
      for (const s of [...tg.subs]) { if (await tgSend(s.id, text)) ok++; await sleep(60); }
      if (!ok) throw new Error('операцию не получил ни один подписчик, повтор в следующем цикле');
      sent.add(k); save();
      await sleep(1100);                                              // лимит Telegram ~1 сообщ/сек в один чат
    }
    all.forEach(x => sent.add(x[1])); save();                         // остальное (без подписчиков или другой уровень) считаем просмотренным
  } finally { busy = false; }
}
async function tgLoop() {
  try { await pollTg(); } catch (e) { console.error('TG:', e.message); }
  setTimeout(tgLoop, TG_POLL);
}
tgStart(); tgLoop();

async function tgApi(req, res, u, send) {
  const J = (c, b) => send(c, 'application/json', JSON.stringify(b));
  try {
    let d = ''; for await (const c of req) d += c;
    const b = d ? JSON.parse(d) : {}, sub = u.pathname.slice('/api/telegram'.length);
    if (req.method === 'GET' && !sub) return J(200, tgState());
    if (req.method === 'POST' && !sub) {
      const token = String(b.token || '').trim();
      let bot; try { bot = await tgCall('getMe', {}, token); }
      catch (e) { throw new Error(e.code ? 'Токен не подошёл. Скопируйте его из @BotFather целиком.' : 'Не удалось связаться с Telegram: ' + e.message); }
      if (token !== tg.token) { tg.subs = []; tg.offset = 0; }
      tg.token = token; tg.bot = { username: bot.username, name: bot.first_name }; sent = null; saveTg();
      await tgStart(); pollTg().catch(e => console.error('TG:', e.message));   // сразу фиксируем текущие операции как старые
      return J(200, tgState());
    }
    if (req.method === 'POST' && sub === '/severity') { tg.sev = b.severity === 'mid' ? ['high', 'mid'] : ['high']; saveTg(); return J(200, tgState()); }
    if (req.method === 'POST' && sub === '/test') {
      if (!tg.subs.length) throw new Error('Нет подписчиков: сначала нажмите Start в боте.');
      for (const s of [...tg.subs]) await tgSend(s.id, '✅ Тестовое уведомление. Всё работает.');
      return J(200, tgState());
    }
    if (req.method === 'DELETE' && !sub) { tgGen++; tg = { ...tg, token: '', bot: null, subs: [], offset: 0 }; saveTg(); return J(200, tgState()); }
    if (req.method === 'DELETE' && sub.startsWith('/subs/')) {
      const id = decodeURIComponent(sub.slice(6)); tg.subs = tg.subs.filter(s => s.id !== id); saveTg(); tgSend(id, 'Вас отключили от уведомлений.');
      return J(200, tgState());
    }
    J(404, { error: 'Не найдено' });
  } catch (e) { J(400, { error: e.message }); }
}


// ───── Виртуальный склад: приход вводится вручную, расход берётся из продаж iiko (в iiko ничего не пишем) ─────
// Данные: stock.json в STATE_DIR. STOCK_TZ — часовой пояс заведения (по умолчанию 5, Ташкент), STOCK_POLL_MIN — как часто проверять остатки для Telegram
// Остаток = последняя инвентаризация (или 0) + приходы + корректировки − продано после этого момента. Каждый раз считается заново, двойного списания не бывает.
const STOCK_FILE = path.join(DIR, 'stock.json'), TZ = +(process.env.STOCK_TZ || 5), STOCK_POLL = (+process.env.STOCK_POLL_MIN || 10) * 60e3;
let stock = { products: {}, ledger: [], locs: [], settings: { leadDays: 3, targetDays: 10, buyHour: 10 }, alerted: {}, buySent: '', orders: [] };   // locs — точки продаж: { id, name, depts: [заведения iiko], regs: [кассы] }
try { const s = JSON.parse(fs.readFileSync(STOCK_FILE, 'utf8')); stock = { ...stock, ...s, settings: { ...stock.settings, ...s.settings } }; } catch (e) {}
const saveStock = () => { try { fs.writeFileSync(STOCK_FILE + '.tmp', JSON.stringify(stock)); fs.renameSync(STOCK_FILE + '.tmp', STOCK_FILE); } catch (e) { console.error('stock:', e.message); } };
const nowLocal = () => new Date(Date.now() + TZ * 36e5).toISOString().slice(0, 19);   // местное время заведения: так же выглядит OpenTime в iiko
const ms = s => Date.parse(String(s).slice(0, 19) + 'Z');
const shiftDay = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const r1 = x => Math.round(x * 10) / 10;
// время продажи приводим к виду 2026-10-23T14:05:00 (как в журнале склада), иначе строки с пробелом и с T сравниваются неверно
const normT = v => String(v || '').trim().replace(' ', 'T').slice(0, 19);
// название без регистра и лишних пробелов: «Sprite бут » и «sprite  бут» — один и тот же товар
const nk = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
// какому товару склада принадлежит строка продажи: по коду iiko, иначе по названию
const matcher = (P, tr) => { const byName = {}; tr.forEach(k => { byName[nk(P[k].name)] = k; }); return r => (P[r.num] && P[r.num].tracked ? r.num : byName[nk(r.name)]); };

// продажи: одна строка = время открытия заказа + товар + количество (удалённое без списания и удалённые заказы не считаются)
async function olapSales(from, to, names) {
  const nm = names && names.length, C = ['OpenTime', 'DishCode', 'DishName'];
  const tiers = [{ f: [...C, 'Department', CASH], dw: true }, { f: [...C, 'Department'], dw: true }, { f: C, dw: true }, { f: C, dw: false }, { f: ['OpenTime', 'DishName'], dw: false }];   // фильтра по названию нет: точное совпадение названия теряло товары
  let err;
  for (const t of tiers) {
    const filters = { 'OpenDate.Typed': { filterType: 'DateRange', periodType: 'CUSTOM', from: from + 'T00:00:00.000', to: to + 'T00:00:00.000', includeLow: true, includeHigh: false },
      OrderDeleted: { filterType: 'IncludeValues', values: ['NOT_DELETED'] } };
    if (t.dw) filters.DeletedWithWriteoff = { filterType: 'IncludeValues', values: ['NOT_DELETED', 'DELETED_WITH_WRITEOFF'] };
    try {
      const res = JSON.parse(await api('/resto/api/v2/reports/olap', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportType: 'SALES', buildSummary: false, groupByRowFields: t.f, aggregateFields: ['DishAmountInt'], filters }) }));
      return (res.data || []).map(r => ({ t: normT(r.OpenTime), num: String(r.DishCode || '').trim(), name: r.DishName || '', q: +r.DishAmountInt || 0, d: r.Department || '', rg: r[CASH] || '' }));
    } catch (e) { err = e; if (!/^409/.test(e.message)) throw e; }
  }
  throw err;
}
let sc = { k: '', at: 0, rows: [] };
async function salesRows(from, to, names) {
  const k = from + '|' + to;
  if (sc.k === k && Date.now() - sc.at < 8e3) return sc.rows;
  sc = { k, at: Date.now(), rows: await olapSales(from, to, names) }; return sc.rows;
}

// справочник товаров из iiko (название + код/артикул); если iiko его не отдаёт — собираем из продаж за 60 дней
let cc = null;
async function catalog() {
  if (cc && Date.now() - cc.at < 6e5) return cc;
  let list, source = 'iiko', note = '';
  try {
    const [pr, gr] = await Promise.all([api('/resto/api/v2/entities/products/list?includeDeleted=false'),
      api('/resto/api/v2/entities/products/group/list?includeDeleted=false').catch(() => '[]')]);
    const groups = {}; JSON.parse(gr).forEach(g => { groups[g.id] = g; });
    const pathOf = id => { const a = []; for (let g = groups[id], n = 0; g && n < 8; g = groups[g.parent], n++) a.unshift(g.name); return a; };
    list = JSON.parse(pr).filter(p => !p.deleted && /^(GOODS|DISH|PREPARED)$/.test(p.type) && (p.num || p.code))
      .map(p => ({ num: String(p.num || p.code), name: p.name, type: p.type, cat: pathOf(p.parent).join(' / ') }));
  } catch (e) {
    source = 'sales'; note = 'Справочник товаров iiko не получен (' + e.message.slice(0, 80) + '): список собран из продаж за 60 дней.';
    const today = nowLocal().slice(0, 10), seen = {};
    (await salesRows(shiftDay(today, -60), shiftDay(today, 2))).forEach(r => { const k = r.num || r.name; if (k && !seen[k]) seen[k] = { num: k, name: r.name || k, type: 'GOODS', cat: '' }; });
    list = Object.values(seen);
  }
  cc = { at: Date.now(), list, source, note }; return cc;
}

async function stockState(loc = '') {
  const cat = await catalog().catch(e => ({ list: [], source: 'none', note: 'Справочник недоступен: ' + e.message.slice(0, 100) }));
  const T = nowLocal(), today = T.slice(0, 10), P = stock.products, S = stock.settings, tr = Object.keys(P).filter(k => P[k].tracked), led = {};
  const LC = stock.locs, def = LC[0] && LC[0].id, cur = loc && LC.find(l => l.id === loc);   // старые записи без точки относятся к первой точке
  const inL = r => !cur || ((!cur.depts.length || cur.depts.includes(r.d)) && (!cur.regs.length || cur.regs.includes(r.rg)));
  stock.ledger.forEach(e => { if (cur && (e.loc || def) !== cur.id) return; (led[e.num] = led[e.num] || []).push(e); });
  let sales = [], salesErr = '';
  if (tr.length) {
    const first = tr.reduce((m, k) => (led[k] || []).reduce((a, e) => e.at.slice(0, 10) < a ? e.at.slice(0, 10) : a, m), today);
    try { sales = await salesRows(shiftDay(first < shiftDay(today, -28) ? first : shiftDay(today, -28), -1), shiftDay(today, 2)); }
    catch (e) { salesErr = 'iiko: ' + e.message.slice(0, 120); }
  }
  const mk = matcher(P, tr);
  const sold = {}; sales.forEach(r => { const k = mk(r); if (k && inL(r)) (sold[k] = sold[k] || []).push(r); });
  const q28 = {}, c28 = ms(T) - 28 * 864e5; tr.forEach(k => { q28[k] = (sold[k] || []).filter(r => ms(r.t) > c28).reduce((x, r) => x + r.q, 0); });
  const ranked = tr.slice().sort((a, b) => q28[b] - q28[a]), totQ = ranked.reduce((x, k) => x + q28[k], 0) || 1, cls = {}; let cum = 0;
  ranked.forEach(k => { cls[k] = cum < totQ * .8 ? 'A' : cum < totQ * .95 ? 'B' : 'C'; cum += q28[k]; });
  const ZK = { A: 1.65, B: 1.28, C: .84 };   // уровень сервиса: A — 95%, B — 90%, C — 80%
  const transitOf = k => stock.orders.filter(o => o.status === 'sent' && (!cur || o.loc === cur.id)).reduce((x, o) => x + o.lines.filter(l => l.num === k).reduce((y, l) => y + (+l.qty || 0), 0), 0);
  const items = {};
  tr.forEach(k => {
    const p = P[k], es = (led[k] || []).slice().sort((a, b) => a.at.localeCompare(b.at)), sl = sold[k] || [];
    const it = items[k] = { num: k, name: p.name, tracked: true, wh: p.wh || 'drinks', min: p.min || 0, pack: p.pack || 1, supplier: p.supplier || '', price: p.price || 0, here: !!(led[k] || []).length, balance: null, status: 'new' };
    if (!es.length) return;
    const ci = es.map(e => e.type).lastIndexOf('count'), t0 = es[ci >= 0 ? ci : 0].at, used = es.slice(ci + 1);
    const bal = (ci >= 0 ? es[ci].qty : 0) + used.reduce((s, e) => s + e.qty, 0) - sl.filter(r => r.t > t0).reduce((s, r) => s + r.q, 0);
    // ── аналитик закупа ──
    // 1) история: продажи по целым суткам за последние 28 дней из iiko (не зависит от даты инвентаризации/прихода)
    const T_ = ms(T), tdMs = ms(today + 'T00:00:00'), lastIn = es.filter(e => e.type === 'in').pop();
    const firstMs = sl.reduce((m, r) => Math.min(m, ms(r.t)), ms(es[0].at)), startMs = Math.max(firstMs, tdMs - 28 * 864e5);
    const dayStart = Math.ceil((startMs - tdMs) / 864e5) * 864e5 + tdMs, n = Math.max(0, Math.round((tdMs - dayStart) / 864e5));   // n полных суток истории
    const bd = {}; sl.forEach(r => { const d = r.t.slice(0, 10); bd[d] = (bd[d] || 0) + r.q; });
    const days = Array.from({ length: n }, (_, j) => new Date(dayStart + j * 864e5).toISOString().slice(0, 10)), v = days.map(d => Math.max(0, bd[d] || 0));
    const mean = n ? v.reduce((x, y) => x + y, 0) / n : 0, sd = n > 1 ? Math.sqrt(v.reduce((x, y) => x + (y - mean) ** 2, 0) / n) : 0;
    const dow = d => new Date(d + 'T00:00:00Z').getUTCDay(), fw = Array(7).fill(0), cw = Array(7).fill(0); days.forEach((d, j) => { fw[dow(d)] += v[j]; cw[dow(d)]++; });
    const wf = w => n >= 14 && mean > 0 && cw[w] >= 2 ? Math.min(2, Math.max(.4, fw[w] / cw[w] / mean)) : 1;   // коэффициент дня недели (после 2 недель истории)
    const h2 = Math.floor(n / 2), a1 = h2 ? v.slice(0, h2).reduce((x, y) => x + y, 0) / h2 : 0, a2 = h2 ? v.slice(n - h2).reduce((x, y) => x + y, 0) / h2 : 0;
    const tr_ = n >= 6 && a1 > 0 ? Math.min(1.25, Math.max(.85, 1 + (a2 - a1) / a1 * .5)) : 1;   // тренд спроса, смягчённый
    const v14 = v.slice(-14), avg = v14.length ? v14.reduce((x, y) => x + y, 0) / v14.length : 0, avgDays = v14.length;
    // 2) прогноз спроса по дням: средний спрос × день недели × тренд; сегодня учитываем только оставшуюся часть суток
    const share = Math.max(.05, 1 - (T_ - tdMs) / 864e5), rate = j => mean * wf(dow(shiftDay(today, j))) * tr_, slot = j => j === 0 ? share : 1;
    const burn = (s0, lim) => { if (s0 <= lim) return 0; let st = s0, t = 0; for (let j = 0; j < 90; j++) { const d = rate(j) * slot(j); if (d > 0 && st - d <= lim) return t + (st - lim) / d * slot(j); st -= d; t += slot(j); } return 90; };
    const need = hh => { let t = 0, x = 0; for (let j = 0; j < 120 && t < hh - 1e-9; j++) { const tk = Math.min(slot(j), hh - t); x += rate(j) * tk; t += tk; } return x; };
    const cl = cls[k] || 'C', L = S.leadDays, H = L + S.targetDays, bp = Math.max(0, bal), trn = transitOf(k);
    const ss = mean > 0 ? ZK[cl] * sd * Math.sqrt(L + 1) : 0;                   // страховой запас на скачки спроса
    const rop = Math.ceil(need(L) + ss);                                           // точка заказа: спрос за срок поставки + страховой запас
    const left = mean > 0 ? burn(bp, 0) : null, orderIn = mean > 0 ? burn(bp, ss) - L : null;   // через сколько дней закончится / через сколько нужно заказать
    const fc = need(H), target = Math.max(fc + ss, it.min * 2), orderGross = Math.max(0, Math.ceil(target - bp)), orderNet = Math.max(0, Math.ceil(target - bp - trn));
    const urgent = orderIn != null && orderIn <= 0 && orderNet > 0;
    const status = bal <= 0 ? 'out' : ((it.min > 0 && bal <= it.min) || urgent) ? 'low' : 'ok';
    const cv = mean > 0 ? sd / mean : null, dAfter = x => new Date(T_ + x * 864e5).toISOString().slice(0, 10);
    Object.assign(it, { daily: Array.from({ length: 14 }, (_, j) => { const d = shiftDay(today, j - 13); return sl.filter(r => r.t.slice(0, 10) === d).reduce((x, r) => x + r.q, 0); }), sold: sl.filter(r => r.t > t0).reduce((x, r) => x + r.q, 0),
      balance: Math.round(bal * 100) / 100, avg: r1(avg), avgDays, hist: n, left: left == null ? null : r1(left), counted: ci >= 0, status, since: t0,
      order: orderGross, orderNet, transit: trn, mean: r1(mean), sd: r1(sd), ss: Math.ceil(ss), rop, fc: Math.round(fc), cl, xyz: cv == null ? '' : cv < .5 ? 'X' : cv < 1 ? 'Y' : 'Z', trend: Math.round((tr_ - 1) * 100),
      orderIn: orderIn == null ? null : r1(orderIn), orderBy: orderIn == null ? null : shiftDay(today, Math.max(0, Math.floor(orderIn))), outDate: left == null || left >= 90 ? null : dAfter(left),
      lastIn: lastIn ? { at: lastIn.at, qty: lastIn.qty } : null });
  });
  const inCat = new Set(cat.list.map(c => c.num));
  const out = cat.list.map(c => items[c.num] ? { ...c, ...items[c.num], name: c.name } : c);
  Object.keys(items).forEach(k => { if (!inCat.has(k)) out.push(items[k]); });
  const locNote = cur && sales.length && (cur.depts.length || cur.regs.length) && !sales.some(r => cur.depts.length ? r.d : r.rg) ? 'iiko не отдал заведения или кассы в продажах: списание по точке недоступно. ' : '';
  return { items: out, orders: stock.orders.slice(-200), lastInv: stock.lastInv || null, locs: LC, loc: cur ? cur.id : '', settings: S, source: cat.source, note: locNote + (cat.note || ''), salesErr, now: T };
}

// Telegram: одно сообщение со всем, что только что стало «заканчивается» или «нет в наличии»
async function stockCheck() {
  if (!(tg.token && tg.bot && tg.subs.length)) return;
  const LS_ = stock.locs.length ? stock.locs : [{ id: '', name: '' }], sts = []; for (const l of LS_) { const s = await stockState(l.id); if (s.salesErr) return; sts.push([l, s]); }
  const A = stock.alerted, rank = { ok: 0, new: 0, low: 1, out: 2 }, msg = [], upd = {};
  sts.forEach(([L, st]) => st.items.filter(i => i.tracked && i.here !== false).forEach(i => {
    const key = L.id ? i.num + '@' + L.id : i.num, prev = A[key] || 'ok', cur = i.status === 'new' ? 'ok' : i.status;
    if (rank[cur] === rank[prev]) return;
    upd[key] = cur;
    if (rank[cur] > rank[prev]) msg.push(`${cur === 'out' ? '🔴' : '🟠'} <b>${esc(i.name)}</b>${L.name ? ' · ' + esc(L.name) : ''} — ${cur === 'out' ? 'закончился' : 'пора заказывать: осталось ' + i.balance + (i.left != null && i.left < 60 ? ', хватит на ~' + i.left + ' дн.' + (i.outDate ? ' (до ' + ruDay(i.outDate) + ')' : '') : '')}${i.orderNet ? ' · заказать ≈ ' + i.orderNet : ''}`);
  }));
  for (let n = 0; n < msg.length; n += 30) {
    let ok = 0; const text = '📦 <b>Склад: пора закупать</b>\n' + LINE + '\n' + msg.slice(n, n + 30).join('\n');
    for (const s of [...tg.subs]) { if (await tgSend(s.id, text)) ok++; await sleep(60); }
    if (!ok) return;   // никто не получил — повторим в следующем цикле
  }
  Object.assign(A, upd); saveStock();
}
async function stockLoop() { try { await stockCheck(); } catch (e) { console.error('stock:', e.message); } try { await buyDigest(); } catch (e) { console.error('buy:', e.message); } setTimeout(stockLoop, STOCK_POLL); }
setTimeout(stockLoop, 20e3);

// ───── Закуп: когда заказывать и что. Заказывать нужно за leadDays дней до конца запаса; объём — на targetDays дней продаж ─────
const WDN = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const ruDay = d => { const x = new Date(d + 'T00:00:00Z'); return WDN[x.getUTCDay()] + ' ' + d.slice(8) + '.' + d.slice(5, 7); };
function buyPlan(st) {
  const L = st.settings.leadDays, today = st.now.slice(0, 10), P = { now: [], soon: [], week: [] };
  st.items.filter(i => i.tracked && i.here !== false && i.balance != null && i.orderNet > 0).forEach(i => {
    let n = null;
    if (i.status === 'out') n = 0; else if (i.orderIn != null) n = Math.floor(i.orderIn); else if (i.min > 0 && i.balance <= i.min) n = 0;
    if (n == null || n > 7) return; n = Math.max(0, n);
    P[n === 0 ? 'now' : n <= 3 ? 'soon' : 'week'].push({ name: i.name, order: i.orderNet, left: i.left, out: i.outDate, status: i.status, by: shiftDay(today, n) });
  });
  Object.values(P).forEach(a => a.sort((x, y) => x.by.localeCompare(y.by) || x.name.localeCompare(y.name, 'ru')));
  return P;
}
function fmtBuy(name, P) {
  const sec = [['🔴 Заказать сегодня', P.now], ['🟠 В ближайшие дни', P.soon], ['🟡 На этой неделе', P.week]].filter(x => x[1].length);
  if (!sec.length) return '';
  return '🛒 <b>Закуп' + (name ? ' · ' + esc(name) : '') + '</b>\n' + LINE + '\n' + sec.map(([t, a]) => '<b>' + t + '</b>\n' + a.map(i =>
    `• ${esc(i.name)} — <b>≈ ${i.order}</b>` + (i.status === 'out' ? ' (закончился)' : i.left != null ? ` (хватит ${i.left >= 60 ? 'более чем на 60 дн.' : 'на ~' + i.left + ' дн.' + (i.out ? ', до ' + ruDay(i.out) : '')})` : '') + (a === P.now ? '' : ' · заказать до ' + ruDay(i.by))).join('\n')).join('\n\n');
}
async function buyMsgs(loc) {
  const L = stock.locs, list = loc ? L.filter(l => l.id === loc) : L.length ? L : [{ id: '', name: '' }], out = [];
  for (const l of list) { const st = await stockState(l.id); if (st.salesErr) throw new Error(st.salesErr); const t = fmtBuy(l.name, buyPlan(st)); if (t) out.push(t); }
  return out;
}
async function buyDigest() {   // раз в день в выбранный час — список закупа в Telegram
  const S = stock.settings; if (!(tg.token && tg.bot && tg.subs.length) || !(S.buyHour >= 0)) return;
  const T = nowLocal(), today = T.slice(0, 10); if (stock.buySent === today || +T.slice(11, 13) < S.buyHour) return;
  const ms = await buyMsgs('');
  for (const t of ms) for (const s of [...tg.subs]) { await tgSend(s.id, t); await sleep(60); }
  stock.buySent = today; saveStock();
}

// ───── Аналитика продаж: реальные продажи из iiko по товарам склада, период против прошлого периода ─────
async function olapAn(from, to, names) {
  const C = ['OpenTime', 'DishCode', 'DishName'], A2 = ['DishAmountInt', 'DishDiscountSumInt'];
  const tiers = [{ f: [...C, 'Department', CASH], a: A2, dw: true }, { f: [...C, 'Department'], a: A2, dw: true }, { f: C, a: A2, dw: true }, { f: C, a: ['DishAmountInt'], dw: true }, { f: C, a: ['DishAmountInt'], dw: false }];
  let err;
  for (const t of tiers) {
    const filters = { 'OpenDate.Typed': { filterType: 'DateRange', periodType: 'CUSTOM', from: from + 'T00:00:00.000', to: to + 'T00:00:00.000', includeLow: true, includeHigh: false },
      OrderDeleted: { filterType: 'IncludeValues', values: ['NOT_DELETED'] } };
    if (t.dw) filters.DeletedWithWriteoff = { filterType: 'IncludeValues', values: ['NOT_DELETED', 'DELETED_WITH_WRITEOFF'] };
    try {
      const res = JSON.parse(await api('/resto/api/v2/reports/olap', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportType: 'SALES', buildSummary: false, groupByRowFields: t.f, aggregateFields: t.a, filters }) }));
      return { rev: t.a.length > 1, rows: (res.data || []).map(r => ({ t: normT(r.OpenTime), num: String(r.DishCode || '').trim(), name: r.DishName || '', q: +r.DishAmountInt || 0, r: +r.DishDiscountSumInt || 0, d: r.Department || '', rg: r[CASH] || '' })) };
    } catch (e) { err = e; if (!/^409/.test(e.message)) throw e; }
  }
  throw err;
}
let anc = { k: '', at: 0, v: null };
async function analytics(loc, days, end) {
  const T = nowLocal(), today = end || T.slice(0, 10), P = stock.products, tr = Object.keys(P).filter(k => P[k].tracked);
  if (!tr.length) return { empty: true, days, loc };
  const names = [], mk = matcher(P, tr);
  const cur = loc && stock.locs.find(l => l.id === loc);
  const inL = r => !cur || ((!cur.depts.length || cur.depts.includes(r.d)) && (!cur.regs.length || cur.regs.includes(r.rg)));
  const from = shiftDay(today, -(2 * days - 1)), key = from + '|' + today + '|' + names.join('|');
  if (!(anc.k === key && Date.now() - anc.at < 60e3)) anc = { k: key, at: Date.now(), v: await olapAn(from, shiftDay(today, 2), names) };
  const { rows, rev } = anc.v, wdi = d => (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7;
  const curDays = Array.from({ length: days }, (_, n) => shiftDay(today, n - days + 1)), cs = new Set(curDays), ps = new Set(Array.from({ length: days }, (_, n) => shiftDay(today, n - 2 * days + 1)));
  const daily = curDays.map(d => ({ d, q: 0, r: 0, dr: 0, sn: 0 })), di = Object.fromEntries(daily.map((x, n) => [x.d, n]));
  const items = {}, hours = Array(24).fill(0), wd = Array(7).fill(0), hm = Array(168).fill(0), wn = Array(7).fill(0), dep = {}, reg = {}, tot = { q: 0, r: 0 }, prv = { q: 0, r: 0 };
  curDays.forEach(d => wn[wdi(d)]++);
  rows.forEach(x => {
    if (!inL(x)) return;
    const k = mk(x); if (!k) return;
    const d = x.t.slice(0, 10), it = items[k] || (items[k] = { num: k, name: P[k].name, wh: P[k].wh || 'drinks', q: 0, r: 0, pq: 0, dl: Array(days).fill(0) });
    if (ps.has(d)) { it.pq += x.q; prv.q += x.q; prv.r += x.r; return; }
    if (!cs.has(d)) return;
    it.q += x.q; it.r += x.r; tot.q += x.q; tot.r += x.r; it.dl[di[d]] += x.q;
    const g = daily[di[d]]; g.q += x.q; g.r += x.r; g[it.wh === 'snacks' ? 'sn' : 'dr'] += x.q;
    const h = +x.t.slice(11, 13); if (h >= 0 && h < 24) { hours[h] += x.q; hm[wdi(d) * 24 + h] += x.q; }
    wd[wdi(d)] += x.q;
    [[x.d, dep], [x.rg, reg]].forEach(([n, m]) => { if (n) { const a = m[n] || (m[n] = { name: n, q: 0, r: 0 }); a.q += x.q; a.r += x.r; } });
  });
  const srt = m => Object.values(m).sort((a, b) => b.q - a.q);
  return { days, from: curDays[0], to: today, loc: cur ? cur.id : '', hasRev: rev, cur: tot, prev: prv, daily, hours, hm, wd: wd.map((v, i) => r1(v / Math.max(1, wn[i]))),
    items: Object.values(items).sort((a, b) => b.q - a.q), dept: srt(dep), regs: srt(reg), now: T };
}

// ───── Мгновенная синхронизация: SSE. Любое изменение склада и любая новая продажа из iiko → всем открытым экранам приходит сигнал ─────
// STOCK_LIVE_SEC — как часто сервер сверяет продажи iiko, пока кто-то открыт (по умолчанию 15 с)
const bus = new Set(); let ver = 0, sig = '', liveBusy = false, liveFail = 0;
const pushStock = why => { ver++; for (const c of bus) c.write(`event: stock\ndata: ${JSON.stringify({ ver, why })}\n\n`); };
const commit = why => { saveStock(); pushStock(why || 'edit'); };
setInterval(() => { for (const c of bus) c.write(': ping\n\n'); }, 25e3).unref();
async function liveLoop() {
  if (bus.size && !liveBusy) {
    liveBusy = true;
    try { const st = await stockState(), s = st.items.filter(i => i.tracked).map(i => i.num + ':' + i.balance + ':' + i.status).join('|') + st.salesErr; if (sig && s !== sig) pushStock('sales'); sig = s; liveFail = st.salesErr ? Math.min(liveFail + 1, 5) : 0; } catch (e) { liveFail = Math.min(liveFail + 1, 5); }
    liveBusy = false;
  }
  setTimeout(liveLoop, (+process.env.STOCK_LIVE_SEC || 15) * 1e3 * 2 ** liveFail);   // при ошибках iiko пауза растёт: 1, 2, 4… минут
}
setTimeout(liveLoop, 5e3);


// ───── Накладные из iiko: приходные накладные за период → приход на склад (только отслеживаемые товары, без дублей) ─────
const whGuess = t => /снек|чипс|орех|арахис|миндал|сухар|печень|шоколад|батончик|конфет|жвач|драже|попкорн|кешью|фисташ|семечк|алпен|alpen|snickers|twix|mars|bounty|lays|pringles|ermak/i.test(t) ? 'snacks' : /напит|вод[аы]|сок|кола|cola|sprite|fanta|pepsi|лимонад|энерг|чай|кофе|пиво|газир|квас|нектар|flash|gorilla|hydrolife|bonaqua|aqua|redbull|red bull|burn|monster|морс|минерал/i.test(t) ? 'drinks' : '';
async function invDocs(from, to) {
  const x = await api(`/resto/api/documents/export/incomingInvoice?from=${from}&to=${to}`);
  const [pr, sp] = await Promise.all([api('/resto/api/v2/entities/products/list?includeDeleted=false').then(JSON.parse).catch(() => []), api('/resto/api/suppliers').catch(() => '')]);
  const leaf = t => { const o = {}; t.replace(/<(\w+)>([^<]*)<\/\1>/g, (_, k, v) => { o[k] = unesc(v); }); return o; };
  const pid = {}; pr.forEach(p => { pid[p.id] = p; });
  const sup = {}; (sp.match(/<(employee|supplier)>[\s\S]*?<\/\1>/g) || []).forEach(e => { const o = leaf(e); if (o.id) sup[o.id] = o.name || ''; });
  const cm = {}; ((await catalog().catch(() => ({ list: [] }))).list).forEach(c => { cm[c.num] = c; });
  const P = stock.products, byName = {}; Object.keys(P).forEach(k => { byName[String(P[k].name || '').toLowerCase()] = k; });
  return (x.match(/<document>[\s\S]*?<\/document>/g) || []).map(d => {
    const h = leaf(d.replace(/<items>[\s\S]*<\/items>/, '')), no = h.documentNumber || '', date = String(h.dateIncoming || '').slice(0, 10);
    const lines = (d.match(/<item>[\s\S]*?<\/item>/g) || []).map((it, i) => {
      const o = leaf(it), pp = pid[o.product] || {}, code = String(o.productArticle || pp.num || pp.code || ''), nm = pp.name || '', k = P[code] ? code : byName[nm.toLowerCase()];
      const tr = !!(k && P[k].tracked), cc = cm[k || code] || {};
      return { i, num: k || code, name: nm || cc.name || code || '?', qty: +o.amount || 0, price: +o.price || 0, sum: +o.sum || 0, tracked: tr, wh: tr ? P[k].wh || 'drinks' : whGuess((nm || cc.name || '') + ' ' + (cc.cat || '')) };
    });
    return { key: no + '|' + date, no, date, supplier: sup[h.supplier] || '', status: h.status || '', lines };
  }).filter(d => d.status !== 'DELETED');
}

// ───── Разделение прихода по точкам ─────
const inLoc = (l, r) => (!l.depts.length || l.depts.includes(r.d)) && (!l.regs.length || l.regs.includes(r.rg));
// целые штуки по весам (метод наибольшего остатка); pack — кратность упаковки: делим упаковками, остаток уходит самой «сильной» точке
function allocate(qty, ids, w, pack) {
  const k = pack > 1 ? pack : 1, units = Math.floor(qty / k + 1e-9), rest = Math.round((qty - units * k) * 1e6) / 1e6;
  let ww = ids.map(id => Math.max(0, +w[id] || 0)); if (!ww.some(x => x > 0)) ww = ww.map(() => 1);
  const sw = ww.reduce((a, b) => a + b, 0), raw = ww.map(x => x / sw * units), base = raw.map(Math.floor); let left = units - base.reduce((a, b) => a + b, 0);
  raw.map((x, i) => [x - base[i], i]).sort((a, b) => b[0] - a[0] || ww[b[1]] - ww[a[1]]).forEach(([, i]) => { if (left > 0) { base[i]++; left--; } });
  const out = {}; ids.forEach((id, i) => { out[id] = base[i] * k; });
  if (rest > 0) out[ids[ww.indexOf(Math.max(...ww))]] += rest;
  return out;
}
// «по потребности»: подбираем общий запас в днях c так, чтобы сумма max(0, c·скорость − остаток) равнялась приходу
function needWeights(qty, b, r) {
  const pos = r.filter(x => x > 0); let lo = 0, hi = (qty + b.reduce((a, x) => a + x, 0)) / Math.min(...pos) + 1;
  for (let i = 0; i < 60; i++) { const c = (lo + hi) / 2, t = r.reduce((a, x, j) => a + Math.max(0, c * x - b[j]), 0); if (t > qty) hi = c; else lo = c; }
  return r.map((x, j) => Math.max(0, lo * x - b[j]));
}
// lines: [{ key, num, qty }] → { out: { key: { locId: qty } }, note }
async function splitAlloc(lines, split) {
  const L = stock.locs, ids = L.map(l => l.id), mode = ['sales', 'need', 'equal', 'manual'].includes(split && split.mode) ? split.mode : 'sales';
  if (L.length < 2) throw new Error('Для разделения нужно минимум 2 точки продаж');
  const nums = [...new Set(lines.map(l => l.num))], sw = {}; let note = '';
  if (mode === 'manual') {
    const m = Object.fromEntries(L.map(l => [l.id, Math.max(0, +((split.w || {})[l.id]) || 0)])); if (!Object.values(m).some(x => x > 0)) throw new Error('Укажите доли точек в процентах');
    nums.forEach(n => { sw[n] = m; });
  } else if (mode === 'equal') nums.forEach(n => { sw[n] = Object.fromEntries(ids.map(id => [id, 1])); });
  else {
    // доли продаж за 14 дней по каждой точке (по товару), сглаженные долей точки во всех продажах: малая выборка не отправит всё на одну точку
    const today = nowLocal().slice(0, 10), P = stock.products, tr = Object.keys(P).filter(k => P[k].tracked), mk = matcher(P, tr);
    const rows = await salesRows(shiftDay(today, -14), shiftDay(today, 2)), per = {}, tot = Object.fromEntries(ids.map(id => [id, 0]));
    rows.forEach(r => { const k = mk(r), q = Math.max(0, r.q); if (!k || !q) return; L.forEach(l => { if (inLoc(l, r)) { per[k] = per[k] || {}; per[k][l.id] = (per[k][l.id] || 0) + q; tot[l.id] += q; } }); });
    const tt = ids.reduce((a, id) => a + tot[id], 0), os = Object.fromEntries(ids.map(id => [id, tt ? tot[id] / tt : 1 / ids.length])), K = 10;
    if (!tt) note = 'нет данных о продажах по точкам — поровну';
    nums.forEach(n => { const q = per[n] || {}, pt = ids.reduce((a, id) => a + (q[id] || 0), 0); sw[n] = Object.fromEntries(ids.map(id => [id, ((q[id] || 0) + K * os[id]) / (pt + K)])); });
  }
  let st = null; if (mode === 'need') { st = {}; for (const l of L) st[l.id] = Object.fromEntries((await stockState(l.id)).items.map(i => [i.num, i])); }
  const out = {};
  lines.forEach(l => {
    let w = sw[l.num]; const pack = (stock.products[l.num] || {}).pack || 1;
    if (st) { const b = ids.map(id => Math.max(0, (st[id][l.num] || {}).balance || 0)), r = ids.map(id => (st[id][l.num] || {}).mean || 0); if (r.some(x => x > 0)) { const nw = needWeights(l.qty, b, r); w = Object.fromEntries(ids.map((id, i) => [id, nw[i]])); } }
    out[l.key] = allocate(l.qty, ids, w, pack);
  });
  return { out, note };
}

async function stockApi(req, res, u, send) {
  const J = (c, b) => send(c, 'application/json', JSON.stringify(b));
  try {
    const sub = u.pathname.slice('/api/stock'.length), post = req.method === 'POST', b = post ? await readBody(req) : {};
    const num = String(b.num || u.searchParams.get('num') || '').trim().slice(0, 60);
    const lq = u.searchParams.get('loc') || '', def0 = stock.locs[0] && stock.locs[0].id, locName = id => (stock.locs.find(l => l.id === (id || def0)) || {}).name || '';
    const pickLoc = x => { if (!stock.locs.length) return ''; const id = String(x || ''); if (stock.locs.some(l => l.id === id)) return id; throw new Error('Выберите точку продаж'); };
    const whenIn = x => /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(x || '') ? String(x).slice(0, 19) : nowLocal();
    if (sub === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n' + `event: hello\ndata: ${JSON.stringify({ ver })}\n\n`); bus.add(res); req.on('close', () => bus.delete(res)); return;
    }
    if (!sub) return J(200, await stockState(u.searchParams.get('loc') || ''));
    if (sub === '/sources') {   // какие заведения и кассы есть в продажах iiko
      const d = nowLocal().slice(0, 10), rows = await olapSales(shiftDay(d, -14), shiftDay(d, 2)), uq = k => [...new Set(rows.map(r => r[k]).filter(Boolean))].sort();
      return J(200, { depts: uq('d'), regs: uq('rg') });
    }
    if (sub === '/sales') {   // полный список продаж отслеживаемых товаров за период
      const t0 = nowLocal().slice(0, 10), pf = u.searchParams.get('from') || '', pt = u.searchParams.get('to') || '', okd = x => /^\d{4}-\d\d-\d\d$/.test(x);
      const to = okd(pt) ? pt : t0; let from = okd(pf) ? pf : to; if ((Date.parse(to) - Date.parse(from)) / 864e5 > 61) from = shiftDay(to, -61);
      const P = stock.products, tr = Object.keys(P).filter(k => P[k].tracked); if (!tr.length) return J(200, { rows: [], from, to, now: nowLocal() });
      const cur = lq && stock.locs.find(l => l.id === lq), inL = r => !cur || ((!cur.depts.length || cur.depts.includes(r.d)) && (!cur.regs.length || cur.regs.includes(r.rg)));
      const mk = matcher(P, tr);
      const rows = (await salesRows(from, shiftDay(to, 1))).filter(inL).map(r => { const k = mk(r); return k ? { t: r.t, num: k, name: P[k].name, wh: P[k].wh || 'drinks', q: r.q, d: r.d, rg: r.rg } : null; }).filter(x => x && x.t.slice(0, 10) >= from && x.t.slice(0, 10) <= to).sort((a, b) => b.t.localeCompare(a.t));
      return J(200, { rows: rows.slice(0, 20000), from, to, now: nowLocal() });
    }
    if (sub === '/analytics') { const d = Math.min(62, Math.max(1, Math.floor(+u.searchParams.get('days')) || 14)), to = u.searchParams.get('to') || '', t0 = nowLocal().slice(0, 10); return J(200, await analytics(lq, d, /^\d{4}-\d\d-\d\d$/.test(to) && to <= t0 ? to : '')); }
    if (sub === '/ledger') return J(200, { entries: stock.ledger.filter(e => e.num === num).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100) });
    if (sub === '/journal') return J(200, { entries: stock.ledger.filter(e => !lq || (e.loc || def0) === lq).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300).map(e => { const p = stock.products[e.num] || {}; return { ...e, name: p.name || e.num, wh: p.wh || 'drinks', locName: locName(e.loc) }; }) });
    if (sub === '/plan') {   // график заказов: что и когда заказывать, по дням
      const st = await stockState(lq), today = st.now.slice(0, 10), days = {};
      st.items.filter(i => i.tracked && i.here !== false && i.balance != null && i.orderNet > 0).forEach(i => {
        const n = i.status === 'out' ? 0 : i.orderIn != null ? Math.max(0, Math.floor(i.orderIn)) : (i.min > 0 && i.balance <= i.min ? 0 : null);
        if (n == null || n > 14) return; const d = shiftDay(today, n); (days[d] = days[d] || []).push({ num: i.num, name: i.name, qty: i.orderNet, left: i.left, cl: i.cl, supplier: i.supplier });
      });
      return J(200, { now: st.now, salesErr: st.salesErr, days: Object.keys(days).sort().map(d => ({ date: d, items: days[d].sort((a, b) => 'ABC'.indexOf(a.cl) - 'ABC'.indexOf(b.cl)) })) });
    }
    if (sub === '/audit') {   // проверка достоверности: где остаток или скорость могут быть неточными
      const st = await stockState(lq), T0 = ms(st.now);
      return J(200, { now: st.now, salesErr: st.salesErr, rows: st.items.filter(i => i.tracked && i.balance != null).map(i => {
        const w = []; if (!i.counted) w.push('нет инвентаризации: остаток = приходы − продажи, товар на полке до первого прихода не учтён');
        if (i.balance < 0) w.push('остаток отрицательный: не внесён приход или нужна инвентаризация');
        if (!i.sold && i.lastIn && T0 - ms(i.lastIn.at) > 2 * 864e5) w.push('после прихода нет продаж: проверьте код и название товара в iiko, точку и кассу');
        if (!i.avgDays) w.push('мало истории продаж (меньше суток): срок «хватит на» не считается');
        return { num: i.num, name: i.name, balance: i.balance, sold: i.sold, avg: i.avg, avgDays: i.avgDays, left: i.left, counted: i.counted, warn: w };
      }).filter(r => r.warn.length) });
    }
    if (sub === '/debug') {   // проверка: что отдаёт iiko (коды товаров и последние продажи)
      const d = nowLocal().slice(0, 10), c = await catalog(), q = (u.searchParams.get('q') || '').toLowerCase(), hit = x => (x.name + ' ' + x.num).toLowerCase().includes(q);
      sc = { k: '', at: 0, rows: [] };   // сбрасываем кэш, чтобы увидеть свежие продажи
      return J(200, { now: nowLocal(), source: c.source, note: c.note,
        tracked: Object.keys(stock.products).filter(k => stock.products[k].tracked).map(k => ({ num: k, name: stock.products[k].name })),
        ledger: stock.ledger.filter(e => !q || (stock.products[e.num] && hit({ name: stock.products[e.num].name || '', num: e.num }))).slice(-10),
        catalog: c.list.filter(hit).slice(0, 10),
        sales: (await salesRows(shiftDay(d, -2), shiftDay(d, 2))).filter(hit).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 15) });
    }
    if (sub === '/invoices') {
      const okd = x => /^\d{4}-\d\d-\d\d$/.test(x), d0 = nowLocal().slice(0, 10), q = k => u.searchParams.get(k) || '', to = okd(q('to')) ? q('to') : d0, from = okd(q('from')) ? q('from') : shiftDay(to, -6);
      if (q('raw')) return J(200, { xml: (await api(`/resto/api/documents/export/incomingInvoice?from=${from}&to=${shiftDay(to, 1)}`)).slice(0, 4000) });
      const done = new Set(stock.ledger.map(e => e.inv).filter(Boolean));
      return J(200, { from, to, docs: (await invDocs(from, shiftDay(to, 1))).filter(d => d.date >= from && d.date <= to).map(d => ({ ...d, done: done.has(d.key) })) });
    }
    if (!post) return J(404, { error: 'Не найдено' });
    if (sub === '/entry') {
      const qty = +b.qty, type = b.type;
      if (!num) throw new Error('Не выбран товар');
      if (!isFinite(qty) || !['in', 'count', 'adj'].includes(type)) throw new Error('Неверные данные');
      if (type === 'in' && qty <= 0) throw new Error('Приход должен быть больше нуля');
      if (type === 'count' && qty < 0) throw new Error('Остаток не может быть отрицательным');
      if (type === 'adj' && qty === 0) throw new Error('Укажите количество');
      const lc = pickLoc(b.loc);
      const p = stock.products[num] || (stock.products[num] = { min: 0 });
      p.name = String(b.name || p.name || num).slice(0, 120); p.tracked = true;
      if (b.wh === 'drinks' || b.wh === 'snacks') p.wh = b.wh; else if (!p.wh) p.wh = 'drinks';
      stock.ledger.push({ id: crypto.randomBytes(6).toString('hex'), num, type, qty, loc: lc, at: whenIn(b.at), note: String(b.note || '').slice(0, 120) });
      commit(); return J(200, { ok: true });
    }
    if (sub === '/split') {   // предпросмотр: как общее количество каждого товара разделится по точкам
      const m = {}; (Array.isArray(b.lines) ? b.lines : []).slice(0, 400).forEach(l => { const n = String(l.num || ''), q = +l.qty; if (!n || !isFinite(q) || q <= 0) return; const g = m[n] || (m[n] = { num: n, name: String(l.name || '').slice(0, 120), qty: 0 }); g.qty += q; });
      const G = Object.values(m).map((g, i) => ({ ...g, key: i })), r = await splitAlloc(G, b);
      return J(200, { rows: G.map(g => ({ num: g.num, name: g.name, qty: g.qty, parts: r.out[g.key] })), note: r.note });
    }
    if (sub === '/transfer') {   // перемещение товара с точки на точку: списание на одной, приход на другой
      const qty = +b.qty, from = String(b.from || ''), to = String(b.to || '');
      if (!num) throw new Error('Не выбран товар'); if (!(qty > 0)) throw new Error('Укажите количество больше нуля');
      if (from === to || !stock.locs.some(l => l.id === from) || !stock.locs.some(l => l.id === to)) throw new Error('Выберите две разные точки');
      const src = (await stockState(from)).items.find(i => i.num === num);
      if (src && src.balance != null && src.balance < qty - 1e-9) throw new Error('На точке «' + locName(from) + '» только ' + src.balance + ' шт');
      const at = whenIn(b.at), xf = crypto.randomBytes(5).toString('hex'), note = ('Перемещение: ' + locName(from) + ' → ' + locName(to) + (b.note ? ' · ' + String(b.note) : '')).slice(0, 120), ids = [];
      [[from, -qty], [to, qty]].forEach(([lid, x]) => { const id = crypto.randomBytes(6).toString('hex'); ids.push(id); stock.ledger.push({ id, num, type: 'adj', qty: x, loc: lid, at, note, xfer: xf }); });
      commit('transfer'); return J(200, { ok: true, ids });
    }
    if (sub === '/invoices/import') {
      if (!/^\d{4}-\d\d-\d\d$/.test(b.from || '') || !/^\d{4}-\d\d-\d\d$/.test(b.to || '')) throw new Error('Неверный период');
      const lc = b.split ? '' : pickLoc(b.loc), keys = Array.isArray(b.keys) ? new Set(b.keys) : null, done = new Set(stock.ledger.map(e => e.inv).filter(Boolean)), T = nowLocal(), pk = b.pick || {}; let n = 0, docs = 0; const ids = [];
      for (const d of await invDocs(b.from, shiftDay(b.to, 1))) {
        if (d.date < b.from || d.date > b.to || done.has(d.key) || (keys && !keys.has(d.key))) continue;
        const L = d.lines.map(l => { const w = pk[d.key + '#' + l.i]; return { ...l, wh: w === '-' ? '' : w || l.wh || (b.all ? (b.def === 'snacks' ? 'snacks' : 'drinks') : '') }; }).filter(l => l.num && l.wh && l.qty > 0); if (!L.length) continue;
        // при разделении: общее количество каждого товара в накладной (строки с одним товаром складываются) делится по точкам один раз
        const LL = b.split ? Object.values(L.reduce((m, l) => { const g = m[l.num] || (m[l.num] = { ...l, qty: 0, sum: 0 }); g.qty += l.qty; g.sum += l.sum; return m; }, {})).map(g => ({ ...g, price: g.qty ? g.sum / g.qty : g.price })) : L;
        const sp = b.split ? (await splitAlloc(LL.map((l, i) => ({ key: i, num: l.num, qty: l.qty })), b.split)).out : null;
        const day0 = /^\d{4}-\d\d-\d\d$/.test(b.at || '') ? b.at : d.date, at = day0 + 'T00:00:00' > T ? T : day0 + 'T00:00:00', batch = crypto.randomBytes(5).toString('hex'); docs++;
        if (!stock.lastInv || d.date >= stock.lastInv.date) stock.lastInv = { no: d.no, date: d.date, supplier: d.supplier, sum: Math.round(L.reduce((t, l) => t + l.sum, 0)) };
        LL.forEach((l, li) => { const p = stock.products[l.num] || (stock.products[l.num] = { min: 0 }); p.name = p.name || l.name; p.tracked = true; if (!p.wh) p.wh = l.wh; if (l.price > 0 && (!p.priceAt || day0 >= p.priceAt)) { p.price = l.price; p.priceAt = day0; } if (d.supplier && !p.supplier) p.supplier = d.supplier; (sp ? Object.entries(sp[li]).filter(([, x]) => x > 0) : [[lc, l.qty]]).forEach(([lid, x]) => { const id = crypto.randomBytes(6).toString('hex'); ids.push(id); stock.ledger.push({ id, num: l.num, type: 'in', qty: x, price: l.price, sum: l.qty ? Math.round(l.sum * x / l.qty * 100) / 100 : l.sum, loc: lid, at, note: ('Накладная №' + d.no + (d.supplier ? ' · ' + d.supplier : '')).slice(0, 120), batch, inv: d.key }); }); n++; });
      }
      if (!n) throw new Error('Нет новых позиций для прихода');
      commit('receive'); return J(200, { ok: true, docs, lines: n, ids });
    }
    if (sub === '/purchase/send') {   // отправить список закупа в Telegram
      if (!(tg.token && tg.bot)) throw new Error('Telegram не подключён: Настройки → Telegram-уведомления');
      if (!tg.subs.length) throw new Error('Нет получателей: откройте бота в Telegram и нажмите Start.');
      const ms = await buyMsgs(String(b.loc || '')); if (!ms.length) throw new Error('Закупать пока нечего');
      let ok = 0; for (const t of ms) for (const s of [...tg.subs]) { if (await tgSend(s.id, t)) ok++; await sleep(60); }
      if (!ok) throw new Error('Telegram не принял сообщение'); return J(200, { ok: true, to: tg.subs.length });
    }
    if (sub === '/locs') {
      const arr = x => (Array.isArray(x) ? x : []).map(v => String(v).slice(0, 80));
      const L = (Array.isArray(b.locs) ? b.locs : []).slice(0, 20).map(l => ({ id: /^[\w-]{4,20}$/.test(l.id || '') ? l.id : crypto.randomBytes(4).toString('hex'), name: String(l.name || '').trim().slice(0, 40), depts: arr(l.depts), regs: arr(l.regs) }));
      if (L.some(l => !l.name)) throw new Error('Назовите каждую точку');
      stock.locs = L; commit('locs'); return J(200, { ok: true, locs: L });
    }
    if (sub === '/receive') {   // поставка целиком: несколько позиций одной операцией
      const L = Array.isArray(b.lines) ? b.lines.slice(0, 200) : []; if (!L.length) throw new Error('Список прихода пуст');
      const lc = b.split ? '' : pickLoc(b.loc), at = whenIn(b.at), note = String(b.note || '').slice(0, 120), batch = crypto.randomBytes(5).toString('hex'), ids = [];
      const ok = L.map(l => { const n = String(l.num || '').trim().slice(0, 60), q = +l.qty; if (!n || !isFinite(q) || q <= 0) throw new Error('Проверьте количество: ' + (l.name || n)); return [n, l, q]; });
      const okA = b.split ? Object.values(ok.reduce((m, [n, l, q]) => { const g = m[n] || (m[n] = [n, l, 0]); g[2] += q; return m; }, {})) : ok;
      const sp = b.split ? (await splitAlloc(okA.map(([n, , q], i) => ({ key: i, num: n, qty: q })), b.split)).out : null;
      okA.forEach(([n, l, q], li) => {
        const p = stock.products[n] || (stock.products[n] = { min: 0 }); p.name = String(l.name || p.name || n).slice(0, 120); p.tracked = true;
        if (l.wh === 'drinks' || l.wh === 'snacks') p.wh = l.wh; else if (!p.wh) p.wh = 'drinks';
        (sp ? Object.entries(sp[li]).filter(([, x]) => x > 0) : [[lc, q]]).forEach(([lid, x]) => { const id = crypto.randomBytes(6).toString('hex'); ids.push(id); stock.ledger.push({ id, num: n, type: 'in', qty: x, loc: lid, at, note, batch }); });
      });
      commit('receive'); return J(200, { ok: true, ids, batch });
    }
    if (sub === '/order/create') {
      const L = (Array.isArray(b.lines) ? b.lines : []).slice(0, 200).map(l => ({ num: String(l.num || '').slice(0, 60), name: String(l.name || '').slice(0, 120), qty: +l.qty, price: Math.max(0, +l.price || 0) })).filter(l => l.num && isFinite(l.qty) && l.qty > 0);
      if (!L.length) throw new Error('В заказе нет позиций');
      const o = { id: crypto.randomBytes(5).toString('hex'), no: stock.orders.reduce((m, x) => Math.max(m, x.no || 0), 0) + 1, at: nowLocal(), loc: pickLoc(b.loc), supplier: String(b.supplier || '').trim().slice(0, 60), note: String(b.note || '').slice(0, 200), status: 'draft', lines: L };
      stock.orders.push(o); commit('order'); return J(200, { ok: true, order: o });
    }
    if (sub === '/order/status') {
      const o = stock.orders.find(x => x.id === b.id); if (!o) throw new Error('Заказ не найден');
      if (!['draft', 'sent', 'received'].includes(b.status)) throw new Error('Неверный статус');
      o.status = b.status; if (b.status === 'sent') o.sentAt = nowLocal(); if (b.status === 'received') { o.receivedAt = nowLocal(); if (!o.sentAt) o.sentAt = o.at; }
      commit('order'); return J(200, { ok: true });
    }
    if (sub === '/order/delete') { stock.orders = stock.orders.filter(x => x.id !== b.id); commit('order'); return J(200, { ok: true }); }
    if (sub === '/order/send') {
      const o = stock.orders.find(x => x.id === b.id); if (!o) throw new Error('Заказ не найден');
      if (!(tg.token && tg.bot)) throw new Error('Telegram не подключён: Настройки → Telegram-уведомления');
      if (!tg.subs.length) throw new Error('Нет получателей: откройте бота в Telegram и нажмите Start.');
      const text = `<b>Заказ №${o.no}${o.supplier ? ' · ' + esc(o.supplier) : ''}</b>\n${LINE}\n` + o.lines.map((l, n) => `${n + 1}. ${esc(l.name)} — <b>${l.qty}</b> шт`).join('\n') + `\n${LINE}\nИтого: ${o.lines.length} поз., ${o.lines.reduce((t, l) => t + l.qty, 0)} шт`;
      let ok = 0; for (const x of [...tg.subs]) { if (await tgSend(x.id, text)) ok++; await sleep(60); }
      if (!ok) throw new Error('Telegram не принял сообщение');
      if (o.status === 'draft') { o.status = 'sent'; o.sentAt = nowLocal(); commit('order'); }
      return J(200, { ok: true, to: tg.subs.length });
    }
    if (sub === '/undo') { const ids = new Set(Array.isArray(b.ids) ? b.ids : []); stock.ledger = stock.ledger.filter(e => !ids.has(e.id)); commit('undo'); return J(200, { ok: true }); }
    if (sub === '/product') {
      const p = stock.products[num]; if (!p) throw new Error('Товар не найден');
      if ('min' in b) p.min = Math.max(0, +b.min || 0);
      if (b.wh === 'drinks' || b.wh === 'snacks') p.wh = b.wh;
      if ('pack' in b) p.pack = Math.max(1, Math.round(+b.pack || 1));
      if ('supplier' in b) p.supplier = String(b.supplier || '').trim().slice(0, 60);
      if (b.untrack) { p.tracked = false; delete stock.alerted[num]; }
      commit(); return J(200, { ok: true });
    }
    if (sub === '/settings') {
      stock.settings = { leadDays: Math.max(0, +b.leadDays || 0), targetDays: Math.max(1, +b.targetDays || 1), buyHour: b.buyHour === '' || b.buyHour == null ? -1 : Math.min(23, Math.max(0, Math.floor(+b.buyHour) || 0)) };
      commit(); return J(200, { ok: true });
    }
    if (sub === '/delete') { const e0 = stock.ledger.find(e => e.id === b.id), xf = e0 && e0.xfer; stock.ledger = stock.ledger.filter(e => e.id !== b.id && !(xf && e.xfer === xf)); commit(); return J(200, { ok: true }); }
    J(404, { error: 'Не найдено' });
  } catch (e) { J(400, { error: e.message }); }
}

// ───── Вход по PIN-коду ─────  (PIN: переменная APP_PIN, по умолчанию 1188)
const PIN_HASH = crypto.createHash('sha256').update(String(process.env.APP_PIN || '1188')).digest();
const SESS_FILE = path.join(__dirname, 'sessions.json');
const sha = x => crypto.createHash('sha256').update(String(x)).digest('hex');
let sessions = {};
try { sessions = JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')); } catch (e) {}
const saveSess = () => {
  const now = Date.now(); for (const k in sessions) if (sessions[k] < now) delete sessions[k];
  try { fs.writeFileSync(SESS_FILE, JSON.stringify(sessions)); } catch (e) {}
};
saveSess();
const cookieOf = (req, name) => { for (const c of (req.headers.cookie || '').split(';')) { const i = c.indexOf('='); if (i > 0 && c.slice(0, i).trim() === name) return decodeURIComponent(c.slice(i + 1).trim()); } return ''; };
const authed = req => { const sid = cookieOf(req, 'sid'); if (!sid) return false; const h = sha(sid), e = sessions[h]; if (!e) return false; if (e < Date.now()) { delete sessions[h]; saveSess(); return false; } return true; };
const clientIp = req => (process.env.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
const tries = new Map();   // ip → { n, lvl, until }  — защита от подбора: 5 ошибок → пауза 30 с, дальше 1, 2, 4… минут (до 10)
const retryIn = ip => { const t = tries.get(ip); return t && t.until > Date.now() ? Math.ceil((t.until - Date.now()) / 1000) : 0; };
setInterval(() => { const now = Date.now(); for (const [k, v] of tries) if (v.until < now - 36e5 && v.n === 0) tries.delete(k); }, 6e5).unref();
const setCookie = (req, sid, maxAge) => 'sid=' + sid + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAge + (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '');

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, data) => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' }); res.end(data); };
  try {
    if (u.pathname === '/' || u.pathname === '/stock') return send(200, 'text/html', fs.readFileSync(path.join(__dirname, 'stock.html')));
    if (u.pathname === '/api/session') return send(200, 'application/json', JSON.stringify({ ok: authed(req), retry: retryIn(clientIp(req)) }));
    if (u.pathname === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req), wait = retryIn(ip);
      if (wait) return send(429, 'application/json', JSON.stringify({ error: 'Слишком много попыток', retry: wait }));
      const b = await readBody(req), t = tries.get(ip) || { n: 0, lvl: 0, until: 0 };
      const good = crypto.timingSafeEqual(crypto.createHash('sha256').update(String(b.pin || '')).digest(), PIN_HASH);
      if (!good) {
        t.n++; let retry = 0, left = 5 - t.n;
        if (t.n >= 5) { retry = Math.min(600, 30 * 2 ** t.lvl); t.lvl++; t.n = 0; t.until = Date.now() + retry * 1000; left = 0; }
        tries.set(ip, t);
        return send(401, 'application/json', JSON.stringify({ error: 'Неверный PIN-код', left, retry }));
      }
      tries.delete(ip);
      const sid = crypto.randomBytes(32).toString('hex'), ttl = b.remember ? 30 * 864e2 : 12 * 36e2;
      sessions[sha(sid)] = Date.now() + ttl * 1000; saveSess();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': setCookie(req, sid, ttl) });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (u.pathname === '/api/logout') {
      const sid = cookieOf(req, 'sid'); if (sid) { delete sessions[sha(sid)]; saveSess(); }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': setCookie(req, '', 0) });
      return res.end('{"ok":true}');
    }
    if (u.pathname.startsWith('/api/') && !authed(req)) return send(401, 'application/json', JSON.stringify({ error: 'auth' }));
    if (u.pathname.startsWith('/api/stock')) return stockApi(req, res, u, send);
    if (u.pathname === '/api/staff') return send(200, 'application/json', JSON.stringify(await staff(u.searchParams)));
    if (u.pathname === '/api/order') return send(200, 'application/json', JSON.stringify(await order(u.searchParams)));
    if (u.pathname === '/api/mark' && req.method === 'POST') {
      const b = await readBody(req), id = String(b.id || '').slice(0, 400), st = b.s === 'ok' || b.s === 'todo' ? b.s : '';
      if (!id) throw new Error('Нет id операции');
      if (st) marks[id] = { s: st, at: new Date().toISOString() }; else delete marks[id];
      saveMarks();
      if (st && b.op && typeof b.op === 'object') notifyMark(b.op, st).catch(e => console.error('TG:', e.message));
      return send(200, 'application/json', JSON.stringify({ marks }));
    }
    if (u.pathname === '/api/danger') return send(200, 'application/json', JSON.stringify({ ...(await danger(u.searchParams)), marks }));
    if (u.pathname.startsWith('/api/telegram')) return tgApi(req, res, u, send);
    send(404, 'text/plain', 'Not found');
  } catch (e) { send(500, 'application/json', JSON.stringify({ error: e.message })); }
}).listen(PORT, '0.0.0.0', () => console.log('http://localhost:' + PORT));

const bye = async () => { try { if (token) await raw('/resto/api/logout?key=' + token); } catch (e) {} process.exit(); };
process.on('SIGINT', bye); process.on('SIGTERM', bye);
