import {
  DomainError, buildDigest, dropTask, esc, getIntakeBatch, getSettings, getTaskById, getTaskDetail, inQuietHours, latestReview, linkTelegramChat,
  localClock, markNotified, notifiedUpTo, ownerMoveTask, ownerSetStatus, pendingNotices, renderNotice, runIntake, runReview,
  setBatchTelegramMessage, t, truncate, updateTask, type Ctx, type Db, type IntakeBatch, type ManagerLlm, type ManagerReview, type Notice,
} from '@conus/core';
import type { TelegramClient, TgCallbackQuery, TgForwardOrigin, TgKeyboard, TgMessage, TgUpdate } from '../telegram/api';

/** Forwarded messages that arrive within this pause are read as one conversation. */
export const INBOX_QUIET_MS = 5_000;
/** More notices than this at once go out as one message. */
const NOTICE_BURST = 5;

export interface BotDeps {
  /** null without a bot token: the daily review still runs, nothing is sent. */
  db: Db; api: TelegramClient | null; llm: ManagerLlm;
  /** The web app's public address; links and buttons only when it is https. */
  publicUrl: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

const owner = (db: Db): Ctx => ({ db, actor: { kind: 'user' } });
const linkable = (url: string) => /^https:\/\//.test(url) && !/^https:\/\/(localhost|127\.|\[::1\])/.test(url);

function authorOf(o: TgForwardOrigin | undefined, fallback: string | null): string | null {
  if (!o) return fallback;
  switch (o.type) {
    case 'user': return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ') || o.sender_user.username || null;
    case 'hidden_user': return o.sender_user_name;
    case 'chat': return o.author_signature ?? o.sender_chat.title ?? null;
    case 'channel': return o.author_signature ?? o.chat.title ?? null;
  }
}

const helpText = () => [
  t('<b>Conus manager</b>', '<b>Главный агент Conus</b>'),
  '',
  t('Forward me messages from clients, colleagues or investors, or just write what needs doing: I will file the work as proposals in the right projects.',
    'Пересылай мне переписку с заказчиками, коллегами, инвестором или просто пиши, что нужно сделать — я разложу задачи по проектам как предложения.'),
  '',
  t('Every morning I send a digest; tasks waiting for your check or blocked come right away (not at night).',
    'Каждое утро присылаю сводку; задачи на проверку и блокеры — сразу (кроме ночи).'),
  '',
  '/digest — ' + t('the digest now', 'сводка сейчас'),
  '/review — ' + t('the manager reviews all projects now', 'ревизия всех проектов сейчас'),
  '/help — ' + t('this help', 'эта справка'),
].join('\n');

export function createBot(deps: BotDeps) {
  const { db, llm, publicUrl } = deps;
  const tg = deps.api;
  // handlers below run only for updates, which only come when there is a bot
  const api = tg as TelegramClient;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.log(`[manager] ${m}`));
  const taskUrl = (id: string) => `${publicUrl.replace(/\/$/, '')}/tasks/${id}`;
  let flushing = false;

  async function linkedChat(): Promise<number | null> {
    return (await getSettings(db)).telegramChatId;
  }

  // ── rendering ──
  function batchView(b: IntakeBatch, picking?: string): { text: string; keyboard: TgKeyboard } {
    const out: string[] = [`🧠 <b>${t('Sorted the correspondence', 'Разобрал переписку')}</b>`];
    if (b.summary) out.push(`<i>${esc(b.summary)}</i>`);
    const keyboard: TgKeyboard = [];
    b.tasks.forEach((x, i) => {
      const n = i + 1;
      const tags = [
        x.priority !== 'normal' ? { urgent: t('🔥 urgent', '🔥 срочно'), high: t('⬆️ high', '⬆️ высокий'), low: t('⬇️ low', '⬇️ низкий') }[x.priority as 'urgent' | 'high' | 'low'] : null,
        x.dueOn ? t(`due ${x.dueOn}`, `до ${x.dueOn}`) : null,
      ].filter(Boolean).join(' · ');
      const state = x.status === 'proposed' ? '' : x.status === 'dropped' ? ` — ✖️ ${t('rejected', 'отклонено')}` : ` — ✅ ${t('accepted', 'принято')}`;
      out.push('', `${n}. <b>${esc(x.ref)}</b>${tags ? ` · ${esc(tags)}` : ''}${state}`, `    ${esc(truncate(x.title, 150))}`);
      if (x.status === 'proposed' && !picking) {
        keyboard.push([
          { text: `✅ ${n}`, callback_data: `pa:${x.id}` },
          { text: `✖️ ${n}`, callback_data: `pr:${x.id}` },
          { text: `📁 ${n}`, callback_data: `pm:${x.id}` },
        ]);
      }
    });
    if (!b.tasks.length) out.push('', t('Nothing new to file.', 'Новых задач не нашёл.'));
    if (b.duplicates.length) {
      out.push('', t('Already on the board:', 'Уже есть на доске:'));
      b.duplicates.forEach((d) => out.push(`• ${esc(truncate(d.title, 80))} → <b>${esc(d.ref)}</b> ${esc(truncate(d.existingTitle, 60))}`));
    }
    const pending = b.tasks.filter((x) => x.status === 'proposed').length;
    if (pending > 1 && !picking) {
      keyboard.push([
        { text: t('✅ Accept all', '✅ Принять все'), callback_data: `ba:${b.id}` },
        { text: t('✖️ Reject all', '✖️ Отклонить все'), callback_data: `br:${b.id}` },
      ]);
    }
    if (pending && !picking) out.push('', t('✅ accept · ✖️ reject · 📁 another project', '✅ принять · ✖️ отклонить · 📁 в другой проект'));
    return { text: out.join('\n'), keyboard };
  }

  async function projectPicker(taskId: string, batchId: number): Promise<TgKeyboard> {
    const task = await getTaskById(db, taskId);
    const { rows } = await db.query('SELECT key FROM projects ORDER BY key');
    const keys = rows.map((r) => r.key as string).filter((k) => k !== task?.projectKey);
    const kb: TgKeyboard = [];
    for (let i = 0; i < keys.length; i += 3) kb.push(keys.slice(i, i + 3).map((k) => ({ text: k, callback_data: `pt:${taskId}:${k}` })));
    kb.push([{ text: t('← Back', '← Назад'), callback_data: `pb:${batchId}` }]);
    return kb;
  }

  function reviewText(r: ManagerReview): string {
    const out = [`🧭 <b>${t('Review', 'Ревизия')}</b>`, esc(r.summary)];
    if (r.focus.length) {
      out.push('', `🎯 <b>${t('Focus for today', 'Фокус на сегодня')}</b>`);
      r.focus.forEach((f, i) => out.push(`${i + 1}. <b>${esc(f.ref)}</b> ${esc(truncate(f.title, 80))}\n    <i>${esc(f.why)}</i>`));
    }
    if (r.changes.length) {
      out.push('', `⚖️ <b>${t('Priorities', 'Приоритеты')}</b>`);
      r.changes.slice(0, 15).forEach((c) => out.push(`• <b>${esc(c.ref)}</b> ${c.from} → ${c.to}${c.applied ? '' : t(' (suggested)', ' (предложено)')} — ${esc(c.reason)}`));
    }
    if (r.findings.length) {
      out.push('', `📝 <b>${t('Notes', 'Заметки')}</b>`);
      r.findings.forEach((f) => out.push(`• ${esc(f.refs.join(', '))}: ${esc(f.note)}`));
    }
    return out.join('\n').slice(0, 4000);
  }

  function noticeKeyboard(n: Notice): TgKeyboard | undefined {
    const row: TgKeyboard[number] = [];
    if (n.kind === 'review') {
      row.push({ text: t('✅ Accept', '✅ Принять'), callback_data: `rv:ok:${n.task.id}` }, { text: t('↩️ Back to work', '↩️ Вернуть'), callback_data: `rv:back:${n.task.id}` });
    }
    if (linkable(publicUrl)) row.push({ text: t('🔗 Open', '🔗 Открыть'), url: taskUrl(n.task.id) });
    return row.length ? [row] : undefined;
  }

  // ── incoming messages ──
  async function onMessage(m: TgMessage) {
    const chatId = m.chat.id;
    if (m.chat.type !== 'private') return;
    const text = (m.text ?? m.caption ?? '').trim();
    const linked = await linkedChat();
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
    if (start) {
      if (start[1] && await linkTelegramChat(db, { code: start[1], chatId, username: m.from?.username ?? null }, now())) {
        await api.sendMessage(chatId, `✅ ${t('Linked. ', 'Привязано. ')}\n\n${helpText()}`);
        log(`telegram linked to chat ${chatId}`);
        return;
      }
      if (linked === chatId) { await api.sendMessage(chatId, helpText()); return; }
      await api.sendMessage(chatId, start[1]
        ? t('That code did not work or has expired. Get a new one in Conus → Settings → Telegram.', 'Код не подошёл или устарел. Возьми новый в Conus → Настройки → Telegram.')
        : t('This is a private Conus bot. Link it in Conus → Settings → Telegram.', 'Это личный бот Conus. Привяжи его в Conus → Настройки → Telegram.'));
      return;
    }
    if (linked !== chatId) {
      await api.sendMessage(chatId, t('This is a private Conus bot.', 'Это личный бот Conus.'));
      return;
    }
    if (/^\/help\b/.test(text)) { await api.sendMessage(chatId, helpText()); return; }
    if (/^\/digest\b/.test(text)) { await api.sendMessage(chatId, await buildDigest(db, linkable(publicUrl) ? publicUrl : null, now())); return; }
    if (/^\/review\b/.test(text)) {
      if (!llm.enabled) { await api.sendMessage(chatId, t('The manager needs an Anthropic API key on the server.', 'Главному агенту нужен ключ Anthropic API на сервере.')); return; }
      await api.sendChatAction(chatId, 'typing').catch(() => {});
      try {
        await api.sendMessage(chatId, reviewText(await runReview({ db, llm, now: now() }, 'owner')));
      } catch (e) {
        await api.sendMessage(chatId, `⚠️ ${esc(e instanceof Error ? e.message : String(e))}`);
      }
      return;
    }
    if (!text) {
      await api.sendMessage(chatId, t('I read text only for now: forward text messages or write.', 'Пока понимаю только текст: перешли текстовые сообщения или напиши.'));
      return;
    }
    if (text.startsWith('/')) { await api.sendMessage(chatId, helpText()); return; }
    await db.query('INSERT INTO telegram_inbox(text, author, received_at) VALUES ($1, $2, $3)',
      [truncate(text, 10_000), authorOf(m.forward_origin, m.forward_origin ? null : t('Me', 'Я')), now()]);
    await api.sendChatAction(chatId, 'typing').catch(() => {});
  }

  /** Reads the forwarded messages once they stop coming, as one conversation. */
  async function flushInbox() {
    if (flushing) return;
    flushing = true;
    try {
      const { rows } = await db.query('SELECT id, text, author, received_at FROM telegram_inbox WHERE processed_at IS NULL ORDER BY id');
      if (!rows.length) return;
      const last = new Date(rows[rows.length - 1].received_at).getTime();
      if (now().getTime() - last < INBOX_QUIET_MS) return;
      const ids = rows.map((r) => r.id);
      await db.query('UPDATE telegram_inbox SET processed_at = now() WHERE id = ANY($1)', [ids]);
      const chatId = await linkedChat();
      if (!chatId) return;
      const text = rows.map((r) => (r.author ? `${r.author}: ${r.text}` : r.text)).join('\n\n');
      const placeholder = await api.sendMessage(chatId, `🧠 ${t('Reading…', 'Разбираю…')}`);
      try {
        const batch = await runIntake({ db, llm, now: now() }, { source: 'telegram', text });
        await db.query('UPDATE telegram_inbox SET batch_id = $2 WHERE id = ANY($1)', [ids, batch.id]);
        await setBatchTelegramMessage(db, batch.id, placeholder.message_id);
        const v = batchView(batch);
        await api.editMessageText(chatId, placeholder.message_id, v.text, v.keyboard);
      } catch (e) {
        const msg = e instanceof DomainError || e instanceof Error ? e.message : String(e);
        await api.editMessageText(chatId, placeholder.message_id,
          `⚠️ ${t('Could not sort it out', 'Не получилось разобрать')}: ${esc(msg)}\n${t('The text is kept on the server.', 'Текст сохранён на сервере.')}`);
      }
    } finally {
      flushing = false;
    }
  }

  // ── buttons ──
  async function batchOfMessage(m: TgMessage | undefined): Promise<IntakeBatch | null> {
    if (!m) return null;
    const { rows } = await db.query('SELECT id FROM intake_batches WHERE telegram_message_id = $1 ORDER BY id DESC LIMIT 1', [m.message_id]);
    return rows[0] ? getIntakeBatch(db, rows[0].id) : null;
  }

  async function redrawBatch(chatId: number, messageId: number, batchId: number) {
    const b = await getIntakeBatch(db, batchId);
    if (!b) return;
    const v = batchView(b);
    await api.editMessageText(chatId, messageId, v.text, v.keyboard);
  }

  async function accept(taskId: string) {
    const x = await getTaskById(db, taskId);
    if (x && x.status === 'proposed') await updateTask(owner(db), { projectId: x.projectId, task: x.ref, promote: true });
  }
  async function reject(taskId: string) {
    const x = await getTaskById(db, taskId);
    if (x && x.status === 'proposed') await dropTask(owner(db), { projectId: x.projectId, task: x.ref, reason: t('Rejected in Telegram', 'Отклонено в Telegram') });
  }

  async function onCallback(q: TgCallbackQuery) {
    const chatId = q.message?.chat.id;
    const linked = await linkedChat();
    if (!chatId || chatId !== linked || q.from.id !== chatId) {
      await api.answerCallbackQuery(q.id, t('Not allowed.', 'Нельзя.'));
      return;
    }
    const data = q.data ?? '';
    const messageId = q.message!.message_id;
    let answer: string | undefined;
    try {
      let m: RegExpExecArray | null;
      if ((m = /^rv:(ok|back):([0-9a-f-]{36})$/.exec(data))) {
        const x = (await getTaskDetail(db, m[2]!))?.task;
        if (x?.status === 'review') {
          const to = m[1] === 'ok' ? 'done' : 'todo';
          await ownerSetStatus(owner(db), { taskId: x.id, status: to, reason: to === 'todo' ? t('Returned from Telegram', 'Возвращено из Telegram') : null });
          answer = to === 'done' ? t('Accepted', 'Принято') : t('Back to work', 'Возвращено в работу');
          await api.editMessageText(chatId, messageId, `${renderNotice({ eventId: 0, kind: 'review', task: x })}\n\n${to === 'done' ? '✅' : '↩️'} <b>${esc(answer)}</b>`);
        } else {
          answer = t('Already handled', 'Уже обработано');
          await api.editMessageText(chatId, messageId, `${q.message?.text ? esc(q.message.text) : ''}\n\n${esc(answer)}`.trim());
        }
      } else if ((m = /^p([ar]):([0-9a-f-]{36})$/.exec(data))) {
        if (m[1] === 'a') { await accept(m[2]!); answer = t('Accepted', 'Принято'); } else { await reject(m[2]!); answer = t('Rejected', 'Отклонено'); }
        const b = await batchOfMessage(q.message);
        if (b) await redrawBatch(chatId, messageId, b.id);
      } else if ((m = /^pm:([0-9a-f-]{36})$/.exec(data))) {
        const b = await batchOfMessage(q.message);
        if (b) {
          const v = batchView(b, m[1]);
          const x = b.tasks.find((y) => y.id === m![1]);
          await api.editMessageText(chatId, messageId, `${v.text}\n\n📁 ${t('Move', 'Перенести')} <b>${esc(x?.ref ?? '')}</b> ${t('to:', 'в:')}`, await projectPicker(m[1]!, b.id));
        }
      } else if ((m = /^pt:([0-9a-f-]{36}):([A-Z0-9]{1,16})$/.exec(data))) {
        const { rows } = await db.query('SELECT id FROM projects WHERE key = $1', [m[2]]);
        if (rows[0]) {
          const r = await ownerMoveTask(owner(db), { taskId: m[1]!, projectId: rows[0].id });
          answer = t(`Moved: ${r.task.ref}`, `Перенесено: ${r.task.ref}`);
        }
        const b = await batchOfMessage(q.message);
        if (b) await redrawBatch(chatId, messageId, b.id);
      } else if ((m = /^pb:(\d+)$/.exec(data))) {
        await redrawBatch(chatId, messageId, Number(m[1]));
      } else if ((m = /^b([ar]):(\d+)$/.exec(data))) {
        const b = await getIntakeBatch(db, Number(m[2]));
        if (b) {
          for (const x of b.tasks.filter((y) => y.status === 'proposed')) await (m[1] === 'a' ? accept(x.id) : reject(x.id));
          await redrawBatch(chatId, messageId, b.id);
          answer = m[1] === 'a' ? t('All accepted', 'Все приняты') : t('All rejected', 'Все отклонены');
        }
      }
    } catch (e) {
      answer = truncate(e instanceof Error ? e.message : String(e), 180);
    }
    await api.answerCallbackQuery(q.id, answer).catch(() => {});
  }

  async function handleUpdate(u: TgUpdate) {
    if (u.message) await onMessage(u.message);
    else if (u.callback_query) await onCallback(u.callback_query);
  }

  // ── outgoing: notices and the digest ──
  async function sendNotices() {
    const s = await getSettings(db);
    const after = await notifiedUpTo(db);
    if (!tg) {
      const { lastId } = await pendingNotices(db, after);
      if (lastId !== after) await markNotified(db, lastId);
      return;
    }
    const { notices, lastId } = await pendingNotices(db, after);
    if (lastId === after) return;
    const wanted = notices.filter((n) => (n.kind === 'review' ? s.notifyReview : s.notifyBlocked));
    const quiet = inQuietHours(localClock(now(), s.timeZone).time, s.quietFrom, s.quietTo);
    // Quiet hours, no chat, or nothing wanted: the feed moves on (the morning digest lists what still waits).
    if (s.telegramChatId && wanted.length && !quiet) {
      if (wanted.length > NOTICE_BURST) {
        const lines = wanted.map((n) => `${n.kind === 'review' ? '👀' : '⛔'} <b>${esc(n.task.ref)}</b> ${esc(truncate(n.task.title, 90))}`);
        await api.sendMessage(s.telegramChatId,
          [`<b>${t(`${wanted.length} tasks need you`, `${wanted.length} задач ждут тебя`)}</b>`, ...lines].join('\n').slice(0, 4000),
          linkable(publicUrl) ? [[{ text: t('🔗 Open Conus', '🔗 Открыть Conus'), url: publicUrl }]] : undefined);
      } else {
        for (const n of wanted) await api.sendMessage(s.telegramChatId, renderNotice(n), noticeKeyboard(n));
      }
    }
    await markNotified(db, lastId);
  }

  /** Once a day at the owner's digest time: the manager's review (when it has a model), then the digest. */
  async function dailyRun() {
    const s = await getSettings(db);
    const clock = localClock(now(), s.timeZone);
    if (clock.time < s.digestTime || s.lastDigestOn === clock.date) return;
    await db.query('UPDATE owner_settings SET last_digest_on = $1 WHERE id = 1', [clock.date]);
    if (llm.enabled && s.lastReviewOn !== clock.date) {
      try {
        const r = await runReview({ db, llm, now: now() }, 'daily');
        log(`daily review: ${r.changes.length} priority changes, ${r.focus.length} in focus`);
      } catch (e) {
        log(`daily review failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (tg && s.telegramChatId) await tg.sendMessage(s.telegramChatId, await buildDigest(db, linkable(publicUrl) ? publicUrl : null, now()));
  }

  return { handleUpdate, flushInbox, sendNotices, dailyRun, batchView, reviewText, latestReview: () => latestReview(db) };
}
