/**
 * A small Telegram Bot API client: the few methods the manager's bot needs. The token is part of every URL, so no
 * error from here ever carries the URL or the raw fetch error: they would put the token in the logs.
 */
export interface TgUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
export interface TgChat { id: number; type: string; title?: string }
export type TgForwardOrigin =
  | { type: 'user'; date: number; sender_user: TgUser }
  | { type: 'hidden_user'; date: number; sender_user_name: string }
  | { type: 'chat'; date: number; sender_chat: TgChat; author_signature?: string }
  | { type: 'channel'; date: number; chat: TgChat; author_signature?: string };
export interface TgMessage {
  message_id: number; date: number; chat: TgChat; from?: TgUser; text?: string; caption?: string; forward_origin?: TgForwardOrigin;
}
export interface TgCallbackQuery { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallbackQuery }
export type TgButton = { text: string; callback_data: string } | { text: string; url: string };
export type TgKeyboard = TgButton[][];

export class TelegramError extends Error {
  constructor(public readonly code: number, message: string, public readonly retryAfter?: number) {
    super(`Telegram: ${message}`);
    this.name = 'TelegramError';
  }
}

export interface TelegramClient {
  getMe(): Promise<TgUser>;
  deleteWebhook(): Promise<void>;
  setMyCommands(commands: { command: string; description: string }[]): Promise<void>;
  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]>;
  sendMessage(chatId: number, text: string, keyboard?: TgKeyboard): Promise<TgMessage>;
  editMessageText(chatId: number, messageId: number, text: string, keyboard?: TgKeyboard): Promise<void>;
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  sendChatAction(chatId: number, action: 'typing'): Promise<void>;
}

export class TelegramApi implements TelegramClient {
  constructor(private readonly token: string, private readonly fetchFn: typeof fetch = fetch) {}

  private async call<T>(method: string, body: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new TelegramError(0, e instanceof Error && e.name === 'TimeoutError' ? `${method} timed out` : `${method}: network error`);
    }
    let json: { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } = {};
    try { json = await res.json() as typeof json; } catch { /* not JSON: handled below */ }
    if (!json.ok) throw new TelegramError(json.error_code ?? res.status, `${method}: ${json.description ?? res.statusText}`, json.parameters?.retry_after);
    return json.result as T;
  }

  getMe() { return this.call<TgUser>('getMe'); }
  async deleteWebhook() { await this.call('deleteWebhook', { drop_pending_updates: false }); }
  async setMyCommands(commands: { command: string; description: string }[]) { await this.call('setMyCommands', { commands }); }
  getUpdates(offset: number, timeoutSec: number) {
    return this.call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, (timeoutSec + 10) * 1000);
  }
  sendMessage(chatId: number, text: string, keyboard?: TgKeyboard) {
    return this.call<TgMessage>('sendMessage', {
      chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  }
  async editMessageText(chatId: number, messageId: number, text: string, keyboard?: TgKeyboard) {
    try {
      await this.call('editMessageText', {
        chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: keyboard ?? [] },
      });
    } catch (e) {
      // pressing a button twice re-renders the same text: not an error
      if (e instanceof TelegramError && /message is not modified/i.test(e.message)) return;
      throw e;
    }
  }
  async answerCallbackQuery(id: string, text?: string) { await this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) }); }
  async sendChatAction(chatId: number, action: 'typing') { await this.call('sendChatAction', { chat_id: chatId, action }); }
}
