import { t, type Db, type ManagerLlm } from '@conus/core';
import { TelegramApi, TelegramError, type TelegramClient } from '../telegram/api';
import { createBot } from './bot';

/** What the web app shows about the manager: shared between the running loops and the UI routes. */
export interface ManagerStatus {
  llm: ManagerLlm;
  /** null without CONUS_TELEGRAM_BOT_TOKEN. */
  api: TelegramClient | null;
  telegram: { configured: boolean; username: string | null; error: string | null };
}

export interface ManagerOptions {
  db: Db; llm: ManagerLlm; token: string | null; publicUrl: string;
  /** Tests pass a fake client; otherwise one is made from the token. */
  api?: TelegramClient | null;
  tickMs?: number; flushMs?: number; pollTimeoutSec?: number;
  log?: (msg: string) => void;
}

/**
 * Starts the manager: the Telegram bot (long polling: no public webhook needed), immediate notices, the inbox of
 * forwarded messages, the daily review and digest, and the reminders between digests. Stopping does not wait for an in-flight long poll.
 */
export function startManager(o: ManagerOptions): { status: ManagerStatus; stop(): void; ready: Promise<void> } {
  const log = o.log ?? ((m: string) => console.log(`[manager] ${m}`));
  const api = o.api !== undefined ? o.api : (o.token ? new TelegramApi(o.token) : null);
  const status: ManagerStatus = { llm: o.llm, api, telegram: { configured: !!api, username: null, error: null } };
  const bot = createBot({ db: o.db, api, llm: o.llm, publicUrl: o.publicUrl, log });
  let running = true;
  const guard = (name: string, fn: () => Promise<void>) => {
    let busy = false;
    return async () => {
      if (busy || !running) return;
      busy = true;
      try { await fn(); } catch (e) { log(`${name} failed: ${e instanceof Error ? e.message : String(e)}`); } finally { busy = false; }
    };
  };
  const tick = guard('tick', async () => { await bot.sendNotices(); await bot.dailyRun(); await bot.remind(); });
  const flush = guard('inbox', () => bot.flushInbox());
  const timers = [setInterval(tick, o.tickMs ?? 15_000), setInterval(flush, o.flushMs ?? 2_000)];
  timers.forEach((x) => x.unref());

  async function poll() {
    if (!api) return;
    let offset = Number((await o.db.query('SELECT telegram_offset AS n FROM owner_settings WHERE id = 1')).rows[0].n);
    while (running) {
      try {
        const updates = await api.getUpdates(offset, o.pollTimeoutSec ?? 25);
        for (const u of updates) {
          if (!running) return;
          try { await bot.handleUpdate(u); } catch (e) { log(`update ${u.update_id} failed: ${e instanceof Error ? e.message : String(e)}`); }
          offset = u.update_id + 1;
          await o.db.query('UPDATE owner_settings SET telegram_offset = $1 WHERE id = 1', [offset]);
        }
      } catch (e) {
        if (!running) return;
        const err = e instanceof TelegramError ? e : null;
        if (rejected(err)) {
          status.telegram.error = t('The bot token was rejected by Telegram.', 'Telegram не принял токен бота.');
          log('telegram rejected the bot token; polling stopped');
          return;
        }
        // 409: another process polls with the same token (e.g. an old copy of the server)
        const wait = err?.retryAfter ? err.retryAfter * 1000 : err?.code === 409 ? 15_000 : 5_000;
        log(`telegram polling: ${err?.message ?? (e instanceof Error ? e.message : String(e))}; retry in ${wait / 1000}s`);
        await new Promise((r) => setTimeout(r, wait).unref());
      }
    }
  }

  const rejected = (e: unknown) => e instanceof TelegramError && (e.code === 401 || e.code === 404);
  /** Connects to Telegram (retrying every minute while it is unreachable), then polls. */
  async function connect(): Promise<void> {
    if (!api) return;
    while (running) {
      try {
        const me = await api.getMe();
        status.telegram.username = me.username ?? null;
        status.telegram.error = null;
        await api.deleteWebhook();
        await api.setMyCommands([
          { command: 'now', description: t('What waits for me now', 'Что ждёт меня сейчас') },
          { command: 'digest', description: t('The digest', 'Сводка') },
          { command: 'review', description: t('Review all projects now', 'Ревизия всех проектов') },
          { command: 'help', description: t('What I can do', 'Что я умею') },
        ]);
        log(`telegram bot @${status.telegram.username} is polling`);
        void poll();
        return;
      } catch (e) {
        log(`telegram start failed: ${e instanceof Error ? e.message : String(e)}`);
        if (rejected(e)) {
          status.telegram.error = t('The bot token was rejected by Telegram.', 'Telegram не принял токен бота.');
          return;
        }
        status.telegram.error = t('Telegram is unreachable; retrying every minute.', 'Telegram недоступен; пробую каждую минуту.');
        await new Promise((r) => setTimeout(r, 60_000).unref());
      }
    }
  }
  const ready = connect();

  return {
    status,
    ready,
    stop() {
      running = false;
      timers.forEach(clearInterval);
    },
  };
}
