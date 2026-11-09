import {
  DomainError, buildDigest, buildNow, dropTask, esc, fitted, getIntakeBatch, getSettings, getTaskById, getTaskDetail, heading, inQuietHours,
  latestReview, link, linkBase, linkTelegramChat, localClock, markNotified, notifiedUpTo, ownerMoveTask, ownerSetStatus, pendingNotices,
  plainText, plural, quote, renderNotice, renderNoticeBurst, renderReview, runIntake, runReview, section, setBatchTelegramMessage, shortDate,
  t, taskLink, truncate, updateTask, type Ctx, type Db, type IntakeBatch, type ManagerLlm, type Notice, type OwnerSettings,
} from '@conus/core';
import { TelegramError, type TelegramClient, type TgCallbackQuery, type TgForwardOrigin, type TgKeyboard, type TgMessage, type TgUpdate } from '../telegram/api';

/** Forwarded messages that arrive within this pause are read as one conversation. */
export const INBOX_QUIET_MS = 5_000;
/** More notices than this at once go out as one message. */
const NOTICE_BURST = 5;
/** A reminder waits this long after an immediate notice: two pings in a row say the same thing. */
const NOTICE_GAP_MS = 30 * 60_000;
const HOUR = 3_600_000;

export interface BotDeps {
  /** null without a bot token: the daily review still runs, nothing is sent. */
  db: Db; api: TelegramClient | null; llm: ManagerLlm;
  /** The web app's public address; links and buttons only when it is https. */
  publicUrl: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

const owner = (db: Db): Ctx => ({ db, actor: { kind: 'user' } });
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function authorOf(o: TgForwardOrigin | undefined, fallback: string | null): string | null {
  if (!o) return fallback;
  switch (o.type) {
    case 'user': return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ') || o.sender_user.username || null;
    case 'hidden_user': return o.sender_user_name;
    case 'chat': return o.author_signature ?? o.sender_chat.title ?? null;
    case 'channel': return o.author_signature ?? o.chat.title ?? null;
  }
}

const everyWords = (n: number) => (n === 1
  ? t('Every hour', 'Каждый час')
  : plural(n, [`Every ${n} hour`, `Every ${n} hours`], [`Каждый ${n} час`, `Каждые ${n} часа`, `Каждые ${n} часов`]));

export function createBot(deps: BotDeps) {
  const { db, llm } = deps;
  const tg = deps.api;
  // handlers below run only for updates, which only come when there is a bot
  const api = tg as TelegramClient;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.log(`[manager] ${m}`));
  const base = linkBase(deps.publicUrl);
  let flushing = false;
  /** When the last immediate notice went out (this process only: after a restart a reminder may follow one closely). */
  let lastNoticeAt = 0;

  async function linkedChat(): Promise<number | null> {
    return (await getSettings(db)).telegramChatId;
  }

  // ── sending ──
  // Markup Telegram refuses (400) goes out again as plain text: one bad message must not stop the feed of notices.
  const plain = (text: string) => esc(truncate(plainText(text), 3900));
  const unparsed = (e: unknown) => e instanceof TelegramError && e.code === 400;
  async function send(chatId: number, text: string, keyboard?: TgKeyboard): Promise<TgMessage> {
    try {
      return await api.sendMessage(chatId, text, keyboard);
    } catch (e) {
      if (!unparsed(e)) throw e;
      log(`telegram refused a message (${(e as Error).message}); sending it as plain text`);
      return api.sendMessage(chatId, plain(text), keyboard);
    }
  }
  async function edit(chatId: number, messageId: number, text: string, keyboard?: TgKeyboard): Promise<void> {
    try {
      await api.editMessageText(chatId, messageId, text, keyboard);
    } catch (e) {
      if (!unparsed(e)) throw e;
      log(`telegram refused an edit (${(e as Error).message}); sending it as plain text`);
      await api.editMessageText(chatId, messageId, plain(text), keyboard);
    }
  }

  // ── rendering ──
  const openButton = () => ({ text: t('🔗 Open Conus', '🔗 Открыть Conus'), url: base! });
  const openKeyboard = (): TgKeyboard | undefined => (base ? [[openButton()]] : undefined);
  const reminderKeyboard = (muted: boolean): TgKeyboard => [
    ...(base ? [[openButton()]] : []),
    [muted
      ? { text: t('🔔 Turn reminders back on', '🔔 Включить напоминания'), callback_data: 'rm:on' }
      : { text: t('🔕 Quiet until the next digest', '🔕 Не напоминать до сводки'), callback_data: 'rm:mute' }],
  ];
  const mutedNote = () => `🔕 <i>${t('No reminders until the next digest.', 'Напоминаний не будет до следующей сводки.')}</i>`;

  function helpText(s: OwnerSettings): string {
    const notices = s.notifyReview && s.notifyBlocked ? t('tasks to check and blockers', 'задачи на проверку и блокеры')
      : s.notifyReview ? t('tasks to check', 'задачи на проверку')
        : s.notifyBlocked ? t('blockers', 'блокеры') : '';
    const settings = t('Conus → Settings', 'Conus → Настройки');
    return [
      `🤖 <b>${t('Conus manager', 'Главный агент Conus')}</b>\n${
        t('I watch the tasks of all your projects and tell you what waits for you.', 'Слежу за задачами всех проектов и говорю, что ждёт тебя.')}`,
      section(`<b>${t('What I do myself', 'Что делаю сам')}</b>`, [
        `☀️ ${llm.enabled
          ? t(`At ${s.digestTime} — a review of all projects and the digest for the day`, `В ${s.digestTime} — ревизия всех проектов и сводка на день`)
          : t(`At ${s.digestTime} — the digest for the day`, `В ${s.digestTime} — сводка на день`)}`,
        s.remindEveryHours > 0
          ? `⏰ ${everyWords(s.remindEveryHours)} — ${t('a reminder, while something waits for you', 'напоминание, пока тебя что-то ждёт')}${
            s.remindersMuted ? t(' (quiet until the next digest)', ' (выключены до следующей сводки)') : ''}`
          : `⏰ ${t('Reminders between digests are off', 'Напоминания между сводками выключены')}`,
        notices ? `👀 ${t('Right away', 'Сразу')} — ${notices}` : '',
        s.quietFrom !== s.quietTo ? `🌙 ${t(`From ${s.quietFrom} to ${s.quietTo} I keep quiet`, `С ${s.quietFrom} до ${s.quietTo} не беспокою`)}` : '',
      ].filter(Boolean)),
      section(`<b>${t('What you can send', 'Что можно прислать')}</b>`, [
        `✍️ ${t('Forward me a conversation with a client, a colleague or an investor, or just write what needs doing. I file it as proposals in the right projects; you accept or reject them.',
          'Перешли переписку с заказчиком, коллегой, инвестором или просто напиши, что нужно сделать. Разложу по проектам как предложения, а ты примешь или отклонишь.')}`,
      ]),
      section(`<b>${t('Commands', 'Команды')}</b>`, [
        `/now — ${t('what waits for me now', 'что ждёт меня сейчас')}`,
        `/digest — ${t('the digest', 'сводка')}`,
        `/review — ${t('review all projects', 'ревизия всех проектов')}`,
        `/help — ${t('this help', 'эта справка')}`,
      ]),
      `<i>${t('The schedule and notifications are in', 'Расписание и уведомления —')} ${base ? link(`${base}/settings`, esc(settings)) : esc(settings)}. ${
        t('Time zone', 'Часовой пояс')}: ${esc(s.timeZone)}.</i>`,
    ].join('\n\n');
  }

  function batchView(b: IntakeBatch, picking?: string): { text: string; keyboard: TgKeyboard } {
    const title = `🧠 <b>${t('Sorted the correspondence', 'Разобрал переписку')}</b>`;
    const pending = b.tasks.filter((x) => x.status === 'proposed').length;
    const items = b.tasks.map((x, i) => {
      const meta = [
        taskLink(x, base), esc(truncate(x.projectName, 40)),
        x.priority !== 'normal' ? { urgent: t('🔥 urgent', '🔥 срочно'), high: t('⬆️ high', '⬆️ высокий'), low: t('⬇️ low', '⬇️ низкий') }[x.priority as 'urgent' | 'high' | 'low'] : '',
        x.dueOn ? esc(t(`due ${shortDate(x.dueOn)}`, `до ${shortDate(x.dueOn)}`)) : '',
        x.status === 'proposed' ? '' : x.status === 'dropped' ? `✖️ ${t('rejected', 'отклонено')}` : `✅ ${t('accepted', 'принято')}`,
      ].filter(Boolean).join(' · ');
      const name = esc(truncate(x.title, 150));
      return `<b>${i + 1}.</b> ${x.status === 'dropped' ? `<s>${name}</s>` : name}\n    ${meta}`;
    });
    const { text, kept } = fitted([
      b.summary ? `${title}\n${quote(esc(b.summary))}` : title,
      ...(items.length ? items : [t('Nothing new to file.', 'Новых задач не нашёл.')]),
      b.duplicates.length ? section(heading('♻️', t('Already on the board', 'Уже есть на доске')), b.duplicates.map((d) =>
        `• ${esc(truncate(d.title, 80))} → <b>${esc(d.ref)}</b> ${esc(truncate(d.existingTitle, 60))}`)) : '',
      pending && !picking ? `<i>${t('✅ accept · ✖️ reject · 📁 another project', '✅ принять · ✖️ отклонить · 📁 в другой проект')}</i>` : '',
    ]);
    // buttons only for the tasks the message shows (a very long batch loses its tail)
    const shown = Math.min(items.length, Math.max(0, kept - 1));
    const keyboard: TgKeyboard = [];
    if (!picking) {
      b.tasks.slice(0, shown).forEach((x, i) => {
        if (x.status !== 'proposed') return;
        keyboard.push([
          { text: `✅ ${i + 1}`, callback_data: `pa:${x.id}` },
          { text: `✖️ ${i + 1}`, callback_data: `pr:${x.id}` },
          { text: `📁 ${i + 1}`, callback_data: `pm:${x.id}` },
        ]);
      });
      if (pending > 1) {
        keyboard.push([
          { text: t('✅ Accept all', '✅ Принять все'), callback_data: `ba:${b.id}` },
          { text: t('✖️ Reject all', '✖️ Отклонить все'), callback_data: `br:${b.id}` },
        ]);
      }
    }
    return { text, keyboard };
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

  function noticeKeyboard(n: Notice): TgKeyboard | undefined {
    const row: TgKeyboard[number] = [];
    if (n.kind === 'review') {
      row.push({ text: t('✅ Accept', '✅ Принять'), callback_data: `rv:ok:${n.task.id}` }, { text: t('↩️ Back to work', '↩️ Вернуть'), callback_data: `rv:back:${n.task.id}` });
    }
    if (base) row.push({ text: t('🔗 Open', '🔗 Открыть'), url: `${base}/tasks/${n.task.id}` });
    return row.length ? [row] : undefined;
  }

  // ── incoming messages ──
  async function onMessage(m: TgMessage) {
    const chatId = m.chat.id;
    if (m.chat.type !== 'private') return;
    const text = (m.text ?? m.caption ?? '').trim();
    const s = await getSettings(db);
    const linked = s.telegramChatId;
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text);
    if (start) {
      if (start[1] && await linkTelegramChat(db, { code: start[1], chatId, username: m.from?.username ?? null }, now())) {
        await send(chatId, `✅ <b>${t('Linked.', 'Привязано.')}</b>\n\n${helpText(await getSettings(db))}`);
        log(`telegram linked to chat ${chatId}`);
        return;
      }
      if (linked === chatId) { await send(chatId, helpText(s)); return; }
      await send(chatId, start[1]
        ? t('That code did not work or has expired. Get a new one in Conus → Settings → Telegram.', 'Код не подошёл или устарел. Возьми новый в Conus → Настройки → Telegram.')
        : t('This is a private Conus bot. Link it in Conus → Settings → Telegram.', 'Это личный бот Conus. Привяжи его в Conus → Настройки → Telegram.'));
      return;
    }
    if (linked !== chatId) {
      await send(chatId, t('This is a private Conus bot.', 'Это личный бот Conus.'));
      return;
    }
    if (/^\/help\b/.test(text)) { await send(chatId, helpText(s)); return; }
    if (/^\/now\b/.test(text)) { await send(chatId, (await buildNow(db, base, now(), 'ask')).text, openKeyboard()); return; }
    if (/^\/digest\b/.test(text)) { await send(chatId, await buildDigest(db, base, now()), openKeyboard()); return; }
    if (/^\/review\b/.test(text)) {
      if (!llm.enabled) { await send(chatId, t('The manager needs an Anthropic API key on the server.', 'Главному агенту нужен ключ Anthropic API на сервере.')); return; }
      await api.sendChatAction(chatId, 'typing').catch(() => {});
      try {
        const messages = await renderReview(db, await runReview({ db, llm, now: now() }, 'owner'), base);
        for (const x of messages) await send(chatId, x);
      } catch (e) {
        await send(chatId, `⚠️ ${esc(e instanceof Error ? e.message : String(e))}`);
      }
      return;
    }
    if (!text) {
      await send(chatId, t('I read text only for now: forward text messages or write.', 'Пока понимаю только текст: перешли текстовые сообщения или напиши.'));
      return;
    }
    if (text.startsWith('/')) { await send(chatId, helpText(s)); return; }
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
      const placeholder = await send(chatId, `🧠 ${t('Reading…', 'Разбираю…')}`);
      try {
        const batch = await runIntake({ db, llm, now: now() }, { source: 'telegram', text });
        await db.query('UPDATE telegram_inbox SET batch_id = $2 WHERE id = ANY($1)', [ids, batch.id]);
        await setBatchTelegramMessage(db, batch.id, placeholder.message_id);
        const v = batchView(batch);
        await edit(chatId, placeholder.message_id, v.text, v.keyboard);
      } catch (e) {
        const msg = e instanceof DomainError || e instanceof Error ? e.message : String(e);
        await edit(chatId, placeholder.message_id,
          `⚠️ <b>${t('Could not sort it out', 'Не получилось разобрать')}</b>\n${quote(esc(truncate(msg, 500)))}\n${t('The text is kept on the server.', 'Текст сохранён на сервере.')}`);
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
    await edit(chatId, messageId, v.text, v.keyboard);
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
          await edit(chatId, messageId, `${renderNotice({ eventId: 0, kind: 'review', task: x }, base)}\n\n${to === 'done' ? '✅' : '↩️'} <b>${esc(answer)}</b>`);
        } else {
          answer = t('Already handled', 'Уже обработано');
          const body = x ? renderNotice({ eventId: 0, kind: 'review', task: x }, base) : esc(q.message?.text ?? '');
          await edit(chatId, messageId, `${body}\n\n<i>${esc(answer)}</i>`.trim());
        }
      } else if ((m = /^rm:(mute|on)$/.exec(data))) {
        const muted = m[1] === 'mute';
        await db.query('UPDATE owner_settings SET reminders_muted = $1 WHERE id = 1', [muted]);
        answer = muted ? t('Quiet until the next digest', 'Не напоминаю до следующей сводки') : t('Reminders are back on', 'Напоминания включены');
        const v = await buildNow(db, base, now(), 'reminder');
        await edit(chatId, messageId, muted ? `${v.text}\n\n${mutedNote()}` : v.text, reminderKeyboard(muted));
      } else if ((m = /^p([ar]):([0-9a-f-]{36})$/.exec(data))) {
        if (m[1] === 'a') { await accept(m[2]!); answer = t('Accepted', 'Принято'); } else { await reject(m[2]!); answer = t('Rejected', 'Отклонено'); }
        const b = await batchOfMessage(q.message);
        if (b) await redrawBatch(chatId, messageId, b.id);
      } else if ((m = /^pm:([0-9a-f-]{36})$/.exec(data))) {
        const b = await batchOfMessage(q.message);
        if (b) {
          const v = batchView(b, m[1]);
          const x = b.tasks.find((y) => y.id === m![1]);
          await edit(chatId, messageId, `${v.text}\n\n📁 ${t('Move', 'Перенести')} <b>${esc(x?.ref ?? '')}</b> ${t('to:', 'в:')}`, await projectPicker(m[1]!, b.id));
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

  // ── outgoing: notices, the digest and reminders ──
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
    // Quiet hours, no chat, or nothing wanted: the feed moves on (the digest and the reminders list what still waits).
    if (s.telegramChatId && wanted.length && !quiet) {
      if (wanted.length > NOTICE_BURST) {
        await send(s.telegramChatId, renderNoticeBurst(wanted, base), openKeyboard());
      } else {
        for (const n of wanted) {
          await send(s.telegramChatId, renderNotice(n, base), noticeKeyboard(n));
          // sent ones are never sent again, even when a later one fails
          await markNotified(db, n.eventId);
        }
      }
      lastNoticeAt = now().getTime();
    }
    await markNotified(db, lastId);
  }

  /** Once a day at the owner's digest time: the manager's review (when it has a model), then the digest. */
  async function dailyRun() {
    const s = await getSettings(db);
    const clock = localClock(now(), s.timeZone);
    if (clock.time < s.digestTime || s.lastDigestOn === clock.date) return;
    // the digest starts a new round of reminders, and ends «quiet until the next digest»
    await db.query('UPDATE owner_settings SET last_digest_on = $1, last_reminder_at = $2, reminders_muted = false WHERE id = 1', [clock.date, now()]);
    if (llm.enabled && s.lastReviewOn !== clock.date) {
      try {
        const r = await runReview({ db, llm, now: now() }, 'daily');
        log(`daily review: ${r.changes.length} priority changes, ${r.focus.length} in focus`);
      } catch (e) {
        log(`daily review failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (tg && s.telegramChatId) await send(s.telegramChatId, await buildDigest(db, base, now()), openKeyboard());
  }

  /**
   * Between digests, every few hours: what waits for the owner — only when something does. Not in quiet hours, not
   * when the digest is about to come, not right after an immediate notice.
   */
  async function remind() {
    if (!tg) return;
    const s = await getSettings(db);
    const every = s.remindEveryHours * HOUR;
    if (!s.telegramChatId || !every || s.remindersMuted) return;
    const at = now();
    const stamp = () => db.query('UPDATE owner_settings SET last_reminder_at = $1 WHERE id = 1', [at]);
    if (!s.lastReminderAt) { await stamp(); return; }
    if (at.getTime() - s.lastReminderAt.getTime() < every) return;
    const clock = localClock(at, s.timeZone);
    if (inQuietHours(clock.time, s.quietFrom, s.quietTo)) return;
    const untilDigest = minutes(s.digestTime) - minutes(clock.time);
    if (s.lastDigestOn !== clock.date && untilDigest > 0 && untilDigest * 60_000 < every) return;
    if (at.getTime() - lastNoticeAt < NOTICE_GAP_MS) return;
    // stamped first: a reminder that fails to send is not retried every tick
    await stamp();
    const v = await buildNow(db, base, at, 'reminder');
    if (v.empty) return;
    await send(s.telegramChatId, v.text, reminderKeyboard(false));
    log('reminder sent');
  }

  return { handleUpdate, flushInbox, sendNotices, dailyRun, remind, batchView, latestReview: () => latestReview(db) };
}
