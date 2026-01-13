require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const Database = require('better-sqlite3');
const db = new Database(process.env.DB_FILE || 'requests.db');
const bot = new Telegraf(process.env.BOT_TOKEN);
const STAFF = (process.env.STAFF_IDS||'').split(',').filter(Boolean).map(Number);
const states = new Map();

db.prepare(`CREATE TABLE IF NOT EXISTS requests(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_chat INTEGER, guest_name TEXT, room TEXT, text TEXT,
  status TEXT, created_at TEXT, accepted_by INTEGER, accepted_at TEXT, completed_at TEXT
)`).run();

function formatReq(r){
  return `#${r.id} | Комн: ${r.room} | Гость: ${r.guest_name||'-'}\nСтатус: ${r.status}\n${r.text}\nСоздано: ${r.created_at}`;
}
function actionKb(r){
  const buttons=[];
  if(r.status==='new') buttons.push(Markup.button.callback('Принять ✅', `accept:${r.id}`));
  if(r.status==='new' || r.status==='accepted') buttons.push(Markup.button.callback('Выполнено ✔️', `complete:${r.id}`));
  return buttons.length? Markup.inlineKeyboard(buttons, {columns:2}): null;
}

bot.start(ctx => ctx.reply('Добро пожаловать. Для заявки используйте /new'));
bot.command('new', ctx => {
  states.set(ctx.chat.id, {step:'room'});
  ctx.reply('Укажите номер комнаты (напр. 502):');
});
bot.on('message', ctx => {
  const s = states.get(ctx.chat.id);
  if(!s) return;
  if(s.step==='room'){ s.room = ctx.message.text.trim(); s.step='text'; ctx.reply('Опишите запрос (кратко):'); return; }
  if(s.step==='text'){ s.text = ctx.message.text.trim(); s.step='guest'; ctx.reply('Имя гостя (или -):'); return; }
  if(s.step==='guest'){
    let guest = ctx.message.text.trim(); if(guest==='-') guest = null;
    const now = new Date().toISOString();
    const stmt = db.prepare(`INSERT INTO requests(guest_chat,guest_name,room,text,status,created_at) VALUES(?,?,?,?,?,?)`);
    const info = stmt.run(ctx.chat.id, guest, s.room, s.text, 'new', now);
    const id = info.lastInsertRowid;
    ctx.reply(`Заявка принята #${id}.`);
    const row = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    for(const sid of STAFF){ try{ bot.telegram.sendMessage(sid, `Новая заявка\n${formatReq(row)}`, actionKb(row)); }catch(e){} }
    states.delete(ctx.chat.id);
  }
});

bot.command('all', async ctx => {
  if(!STAFF.includes(ctx.from.id)) return ctx.reply('Доступ только персоналу.');
  const rows = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 50').all();
  if(!rows.length) return ctx.reply('Заявок нет.');
  for(const r of rows) await ctx.reply(formatReq(r), actionKb(r));
});

bot.on('callback_query', async ctx => {
  const from = ctx.from.id;
  const data = ctx.callbackQuery.data;
  if(!STAFF.includes(from)) return ctx.answerCbQuery('Доступ только персоналу.', {show_alert:true});
  const [cmd, sid] = data.split(':');
  const id = Number(sid);
  const row = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
  if(!row){ await ctx.editMessageText('Заявка не найдена.'); return ctx.answerCbQuery(); }
  if(cmd==='accept'){
    db.prepare('UPDATE requests SET status=?,accepted_by=?,accepted_at=? WHERE id=?')
      .run('accepted', from, new Date().toISOString(), id);
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    await ctx.editMessageText(formatReq(r), actionKb(r));
    try{ await bot.telegram.sendMessage(r.guest_chat, `Ваша заявка #${id} принята персоналом.`); }catch(e){}
    return ctx.answerCbQuery();
  }
  if(cmd==='complete'){
    db.prepare('UPDATE requests SET status=?,completed_at=? WHERE id=?')
      .run('completed', new Date().toISOString(), id);
    const r = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    await ctx.editMessageText(formatReq(r), actionKb(r));
    try{ await bot.telegram.sendMessage(r.guest_chat, `Ваша заявка #${id} выполнена. Благодарим.`); }catch(e){}
    return ctx.answerCbQuery();
  }
});

bot.launch();
process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM', ()=>bot.stop('SIGTERM'));
