import { Buffer } from "node:buffer";
import { DurableObject } from "cloudflare:workers";

const PRIVATE_CHAT_HELP =
  "Надішліть мені голосове повідомлення, і я перетворю його на текст.";
const TOO_LARGE_MESSAGE =
  "Це голосове повідомлення завелике для розпізнавання. Будь ласка, надішліть коротше.";
const EMPTY_TRANSCRIPTION_MESSAGE =
  "Не вдалося розпізнати текст в цьому голосовому повідомленні.";
const TEMPORARY_ERROR_MESSAGE =
  "На жаль, не вдалося розпізнати це голосове повідомлення. Будь ласка, спробуйте ще раз.";
const DAILY_LIMIT_MESSAGE =
  "Денний ліміт розпізнавання вичерпано. Будь ласка, спробуйте ще раз після 00:00 UTC.";
const NOT_ALLOWED_MESSAGE =
  "Цьому чату не дозволено використовувати розпізнавання голосу. Ви можете розгорнути власного бота: https://github.com/BUSHA/tg-voice-to-text-cf";
const GUEST_NOT_ALLOWED_MESSAGE =
  "Вам не дозволено використовувати розпізнавання голосу. Ви можете розгорнути власного бота: https://github.com/BUSHA/tg-voice-to-text-cf";
const GUEST_HELP_MESSAGE =
  "Згадайте мене у відповіді на голосове або аудіоповідомлення, і я розпізнаю його.";
const TELEGRAM_MESSAGE_LIMIT = 4096;

interface TelegramUpdate {
  message?: TelegramMessage;
  guest_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
  };
  from?: {
    id: number;
    is_bot?: boolean;
  };
  guest_query_id?: string;
  reply_to_message?: TelegramMessage;
  voice?: TelegramMedia;
  audio?: TelegramMedia;
}

interface TelegramMedia {
  file_id: string;
  file_size?: number;
  duration?: number;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramFile {
  file_path?: string;
}

interface TelegramBot {
  id: number;
  username?: string;
  supports_guest_queries?: boolean;
}

interface TelegramWebhookInfo {
  allowed_updates?: string[];
  last_error_message?: string;
  pending_update_count: number;
  url: string;
}

interface RuntimeConfig {
  allowPrivateChats: boolean;
  allowedChatIds: Set<string>;
  dailyTranscriptionSeconds: number;
  maxFileSizeBytes: number;
  maxDurationSeconds: number;
  language?: string;
  model: string;
}

interface BudgetReservation {
  allowed: boolean;
  limitSeconds: number;
  reservedSeconds: number;
}

interface BudgetStats {
  limitSeconds: number;
  remainingSeconds: number;
  reservedSeconds: number;
  utcDate: string;
}

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Бот розпізнавання голосових повідомлень Telegram працює");
    }

    const webhookSecret = getPathSecret(url.pathname);
    if (request.method !== "POST" || webhookSecret === undefined) {
      return new Response("Не знайдено", { status: 404 });
    }

    if (webhookSecret !== env.WEBHOOK_SECRET) {
      return new Response("Не знайдено", { status: 404 });
    }

    let update: TelegramUpdate;
    try {
      update = await request.json<TelegramUpdate>();
    } catch (error) {
      logError("Некоректний JSON вебхука Telegram", error);
      return new Response("OK");
    }

    ctx.waitUntil(handleUpdate(update, env, request.url));
    return new Response("OK");
  },
} satisfies ExportedHandler<Cloudflare.Env>;

async function handleUpdate(
  update: TelegramUpdate,
  env: Cloudflare.Env,
  webhookUrl: string,
): Promise<void> {
  if (update.guest_message) {
    await handleGuestMessage(update.guest_message, env);
    return;
  }

  const message = update.message;
  if (!message || message.from?.is_bot) {
    return;
  }

  if (message.text?.match(/^\/chatid(?:@\w+)?$/)) {
    await safelySendMessage(
      env,
      message.chat.id,
      `ID чату: ${message.chat.id}`,
      message.message_id,
    );
    return;
  }

  const config = getRuntimeConfig(env);
  const isStartCommand = /^\/start(?:@\w+)?(?:\s|$)/.test(message.text ?? "");
  if (
    message.chat.type === "private" &&
    !config.allowPrivateChats &&
    !config.allowedChatIds.has(String(message.chat.id))
  ) {
    console.warn({
      message: "Оновлення з приватного чату проігноровано",
      chatId: message.chat.id,
    });
    if (isStartCommand || message.voice || message.audio) {
      await safelySendMessage(env, message.chat.id, NOT_ALLOWED_MESSAGE, message.message_id);
    }
    return;
  }

  if (!isAllowedChat(config.allowedChatIds, message.chat.id)) {
    console.warn({
      message: "Оновлення з чату, якого немає в списку дозволених, проігноровано",
      chatId: message.chat.id,
      chatType: message.chat.type,
    });
    if (isStartCommand || message.voice || message.audio) {
      await safelySendMessage(env, message.chat.id, NOT_ALLOWED_MESSAGE, message.message_id);
    }
    return;
  }

  if (message.text?.match(/^\/stats(?:@\w+)?$/)) {
    try {
      const stats = await getDailyBudgetStats(env, config.dailyTranscriptionSeconds);
      await sendMessage(env, message.chat.id, formatBudgetStats(stats), message.message_id);
    } catch (error) {
      logError("Не вдалося отримати статистику денного ліміту", error);
      await safelySendMessage(env, message.chat.id, TEMPORARY_ERROR_MESSAGE, message.message_id);
    }
    return;
  }

  if (message.text?.match(/^\/setupguest(?:@\w+)?$/)) {
    try {
      await setTelegramWebhook(env, webhookUrl);
      const status = await getTelegramGuestStatus(env);
      await sendMessage(
        env,
        message.chat.id,
        formatTelegramGuestStatus(status),
        message.message_id,
      );
    } catch (error) {
      logError("Не вдалося ввімкнути гостьові оновлення Telegram", error);
      await safelySendMessage(env, message.chat.id, TEMPORARY_ERROR_MESSAGE, message.message_id);
    }
    return;
  }

  if (message.text?.match(/^\/gueststatus(?:@\w+)?$/)) {
    try {
      const status = await getTelegramGuestStatus(env);
      await sendMessage(
        env,
        message.chat.id,
        formatTelegramGuestStatus(status),
        message.message_id,
      );
    } catch (error) {
      logError("Не вдалося отримати статус гостьового режиму Telegram", error);
      await safelySendMessage(env, message.chat.id, TEMPORARY_ERROR_MESSAGE, message.message_id);
    }
    return;
  }

  const media = message.voice ?? message.audio;
  if (!media) {
    if (message.chat.type === "private") {
      await safelySendMessage(env, message.chat.id, PRIVATE_CHAT_HELP, message.message_id);
    }
    return;
  }

  console.info({
    message: "Отримано повідомлення Telegram для розпізнавання",
    chatId: message.chat.id,
    chatType: message.chat.type,
    durationSeconds: media.duration,
  });

  if (
    (media.file_size !== undefined && media.file_size > config.maxFileSizeBytes) ||
    (media.duration !== undefined && media.duration > config.maxDurationSeconds)
  ) {
    await safelySendMessage(env, message.chat.id, TOO_LARGE_MESSAGE, message.message_id);
    return;
  }

  try {
    const reservationSeconds = media.duration ?? config.maxDurationSeconds;
    const reservation = await reserveDailyBudget(
      env,
      reservationSeconds,
      config.dailyTranscriptionSeconds,
    );
    if (!reservation.allowed) {
      await safelySendMessage(env, message.chat.id, DAILY_LIMIT_MESSAGE, message.message_id);
      return;
    }

    const file = await getTelegramFile(env, media.file_id);
    if (!file.file_path) {
      throw new TelegramApiError("Відповідь Telegram getFile не містить file_path");
    }

    const audio = await downloadTelegramFile(env, file.file_path, config.maxFileSizeBytes);
    const text = await transcribeAudio(env, audio, config);

    if (!text) {
      await sendMessage(env, message.chat.id, EMPTY_TRANSCRIPTION_MESSAGE, message.message_id);
      return;
    }

    await sendTranscription(env, message.chat.id, message.message_id, text);
  } catch (error) {
    if (error instanceof RangeError) {
      await safelySendMessage(env, message.chat.id, TOO_LARGE_MESSAGE, message.message_id);
      return;
    }

    logError("Не вдалося розпізнати голосове повідомлення", error);
    await safelySendMessage(env, message.chat.id, TEMPORARY_ERROR_MESSAGE, message.message_id);
  }
}

async function handleGuestMessage(
  message: TelegramMessage,
  env: Cloudflare.Env,
): Promise<void> {
  const guestQueryId = message.guest_query_id;
  if (!guestQueryId || message.from?.is_bot) {
    return;
  }

  const config = getRuntimeConfig(env);
  const callerId = message.from?.id;
  if (callerId === undefined || !isAllowedChat(config.allowedChatIds, callerId)) {
    console.warn({
      message: "Відхилено гостьовий запит від користувача, якого немає в списку дозволених",
      callerId,
      chatId: message.chat.id,
      chatType: message.chat.type,
    });
    await safelyAnswerGuestQuery(env, guestQueryId, GUEST_NOT_ALLOWED_MESSAGE);
    return;
  }

  const media = message.reply_to_message?.voice ?? message.reply_to_message?.audio;
  if (!media) {
    await safelyAnswerGuestQuery(env, guestQueryId, GUEST_HELP_MESSAGE);
    return;
  }

  console.info({
    message: "Отримано гостьовий запит Telegram для розпізнавання",
    callerId,
    chatId: message.chat.id,
    chatType: message.chat.type,
    durationSeconds: media.duration,
  });

  if (
    (media.file_size !== undefined && media.file_size > config.maxFileSizeBytes) ||
    (media.duration !== undefined && media.duration > config.maxDurationSeconds)
  ) {
    await safelyAnswerGuestQuery(env, guestQueryId, TOO_LARGE_MESSAGE);
    return;
  }

  try {
    const reservationSeconds = media.duration ?? config.maxDurationSeconds;
    const reservation = await reserveDailyBudget(
      env,
      reservationSeconds,
      config.dailyTranscriptionSeconds,
    );
    if (!reservation.allowed) {
      await safelyAnswerGuestQuery(env, guestQueryId, DAILY_LIMIT_MESSAGE);
      return;
    }

    const file = await getTelegramFile(env, media.file_id);
    if (!file.file_path) {
      throw new TelegramApiError("Відповідь Telegram getFile не містить file_path");
    }

    const audio = await downloadTelegramFile(env, file.file_path, config.maxFileSizeBytes);
    const text = await transcribeAudio(env, audio, config);
    await answerGuestQuery(
      env,
      guestQueryId,
      text ? `📝 ${text}` : EMPTY_TRANSCRIPTION_MESSAGE,
    );
  } catch (error) {
    if (error instanceof RangeError) {
      await safelyAnswerGuestQuery(env, guestQueryId, TOO_LARGE_MESSAGE);
      return;
    }

    logError("Не вдалося розпізнати голосове повідомлення з гостьового запиту", error);
    await safelyAnswerGuestQuery(env, guestQueryId, TEMPORARY_ERROR_MESSAGE);
  }
}

function getRuntimeConfig(env: Cloudflare.Env): RuntimeConfig {
  return {
    allowPrivateChats: parseBoolean(env.ALLOW_PRIVATE_CHATS, true),
    allowedChatIds: parseAllowedChatIds(env.ALLOWED_CHAT_IDS),
    dailyTranscriptionSeconds: parsePositiveInteger(
      env.DAILY_TRANSCRIPTION_SECONDS,
      6_000,
    ),
    maxFileSizeBytes: parsePositiveInteger(env.MAX_FILE_SIZE_BYTES, 20_000_000),
    maxDurationSeconds: parsePositiveInteger(env.MAX_DURATION_SECONDS, 300),
    language: env.DEFAULT_LANGUAGE?.trim() || undefined,
    model: env.WHISPER_MODEL?.trim() || "@cf/openai/whisper-large-v3-turbo",
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return fallback;
}

function parseAllowedChatIds(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((chatId) => chatId.trim())
      .filter(Boolean),
  );
}

function isAllowedChat(allowedChatIds: Set<string>, chatId: number): boolean {
  return allowedChatIds.size === 0 || allowedChatIds.has(String(chatId));
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function reserveDailyBudget(
  env: Cloudflare.Env,
  requestedSeconds: number,
  limitSeconds: number,
): Promise<BudgetReservation> {
  const budget = env.DAILY_BUDGET.getByName("global");
  return budget.reserve(getUtcDate(), requestedSeconds, limitSeconds);
}

async function getDailyBudgetStats(
  env: Cloudflare.Env,
  limitSeconds: number,
): Promise<BudgetStats> {
  const budget = env.DAILY_BUDGET.getByName("global");
  return budget.stats(getUtcDate(), limitSeconds);
}

function formatBudgetStats(stats: BudgetStats): string {
  return [
    `Денне використання розпізнавання (${stats.utcDate} UTC):`,
    `Використано: ${formatMinutes(stats.reservedSeconds)}`,
    `Залишилося: ${formatMinutes(stats.remainingSeconds)}`,
    `Ліміт: ${formatMinutes(stats.limitSeconds)}`,
    "Скидання о 00:00 UTC.",
  ].join("\n");
}

function formatMinutes(seconds: number): string {
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} хв`;
}

function getUtcDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function getPathSecret(pathname: string): string | undefined {
  const match = /^\/telegram\/([^/]+)\/?$/.exec(pathname);
  if (!match) {
    return undefined;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

async function telegramApi<T>(
  env: Cloudflare.Env,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    },
  );

  let body: TelegramApiResponse<T>;
  try {
    body = await response.json<TelegramApiResponse<T>>();
  } catch {
    throw new TelegramApiError(`Telegram ${method} повернув некоректний JSON`, response.status);
  }

  if (!response.ok || !body.ok || body.result === undefined) {
    throw new TelegramApiError(
      `Помилка Telegram ${method}: ${body.description ?? response.statusText}`,
      response.status,
    );
  }

  return body.result;
}

async function sendMessage(
  env: Cloudflare.Env,
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };

  if (replyToMessageId !== undefined) {
    payload.reply_parameters = {
      message_id: replyToMessageId,
      allow_sending_without_reply: true,
    };
  }

  await telegramApi(env, "sendMessage", payload);
}

async function safelySendMessage(
  env: Cloudflare.Env,
  chatId: number,
  text: string,
  replyToMessageId?: number,
): Promise<void> {
  try {
    await sendMessage(env, chatId, text, replyToMessageId);
  } catch (error) {
    logError("Не вдалося надіслати повідомлення Telegram", error);
  }
}

async function setTelegramWebhook(env: Cloudflare.Env, webhookUrl: string): Promise<void> {
  await telegramApi(env, "setWebhook", {
    url: webhookUrl,
    allowed_updates: ["message", "guest_message"],
  });
}

async function getTelegramGuestStatus(
  env: Cloudflare.Env,
): Promise<{ bot: TelegramBot; webhook: TelegramWebhookInfo }> {
  const [bot, webhook] = await Promise.all([
    telegramApi<TelegramBot>(env, "getMe", {}),
    telegramApi<TelegramWebhookInfo>(env, "getWebhookInfo", {}),
  ]);
  return { bot, webhook };
}

function formatTelegramGuestStatus({
  bot,
  webhook,
}: {
  bot: TelegramBot;
  webhook: TelegramWebhookInfo;
}): string {
  const allowedUpdates = webhook.allowed_updates?.join(", ") || "усі типові оновлення";
  return [
    `Бот: @${bot.username ?? "невідомо"}`,
    `Підтримка гостьового режиму: ${bot.supports_guest_queries === true ? "увімкнено" : "НЕ ввімкнено"}`,
    `Підписка вебхука на guest_message: ${
      webhook.allowed_updates?.includes("guest_message") ? "увімкнено" : "НЕ ввімкнено"
    }`,
    `Оновлення вебхука: ${allowedUpdates}`,
    `Оновлень в очікуванні: ${webhook.pending_update_count}`,
    ...(webhook.last_error_message
      ? [`Остання помилка вебхука: ${webhook.last_error_message}`]
      : []),
  ].join("\n");
}

async function answerGuestQuery(
  env: Cloudflare.Env,
  guestQueryId: string,
  text: string,
): Promise<void> {
  const messageText = splitTelegramText(text, TELEGRAM_MESSAGE_LIMIT)[0];
  await telegramApi(env, "answerGuestQuery", {
    guest_query_id: guestQueryId,
    result: {
      type: "article",
      id: "voice-transcription",
      title: "Розпізнавання голосу",
      input_message_content: {
        message_text: messageText,
      },
    },
  });
}

async function safelyAnswerGuestQuery(
  env: Cloudflare.Env,
  guestQueryId: string,
  text: string,
): Promise<void> {
  try {
    await answerGuestQuery(env, guestQueryId, text);
  } catch (error) {
    logError("Не вдалося відповісти на гостьовий запит Telegram", error);
  }
}

async function getTelegramFile(env: Cloudflare.Env, fileId: string): Promise<TelegramFile> {
  return telegramApi<TelegramFile>(env, "getFile", { file_id: fileId });
}

async function downloadTelegramFile(
  env: Cloudflare.Env,
  filePath: string,
  maxFileSizeBytes: number,
): Promise<ArrayBuffer> {
  const response = await fetch(
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`,
  );
  if (!response.ok) {
    throw new TelegramApiError("Не вдалося завантажити файл Telegram", response.status);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxFileSizeBytes) {
    throw new RangeError("Файл Telegram перевищує налаштований максимальний розмір");
  }

  const audio = await response.arrayBuffer();
  if (audio.byteLength > maxFileSizeBytes) {
    throw new RangeError("Файл Telegram перевищує налаштований максимальний розмір");
  }

  return audio;
}

async function transcribeAudio(
  env: Cloudflare.Env,
  audio: ArrayBuffer,
  config: RuntimeConfig,
): Promise<string> {
  if (config.model === "@cf/openai/whisper-large-v3-turbo") {
    const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio: Buffer.from(audio).toString("base64"),
      task: "transcribe",
      ...(config.language ? { language: config.language } : {}),
    });
    return result.text.trim();
  }

  if (config.model !== "@cf/openai/whisper") {
    throw new Error(`Непідтримувана модель WHISPER_MODEL: ${config.model}`);
  }

  const result = await env.AI.run("@cf/openai/whisper", {
    audio: Array.from(new Uint8Array(audio)),
  });
  return result.text.trim();
}

async function sendTranscription(
  env: Cloudflare.Env,
  chatId: number,
  replyToMessageId: number,
  transcription: string,
): Promise<void> {
  const chunks = splitTelegramText(`📝 ${transcription}`, TELEGRAM_MESSAGE_LIMIT);
  for (const [index, chunk] of chunks.entries()) {
    await sendMessage(env, chatId, chunk, index === 0 ? replyToMessageId : undefined);
  }
}

function splitTelegramText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < Math.floor(maxLength / 2)) {
      splitAt = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitAt < Math.floor(maxLength / 2)) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function logError(message: string, error: unknown): void {
  console.error({
    message,
    error:
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : String(error),
  });
}

export class DailyBudget extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS daily_budget (
          utc_date TEXT PRIMARY KEY,
          reserved_seconds INTEGER NOT NULL
        )
      `);
    });
  }

  reserve(
    utcDate: string,
    requestedSeconds: number,
    limitSeconds: number,
  ): BudgetReservation {
    const safeRequestedSeconds = Math.max(1, Math.ceil(requestedSeconds));
    const safeLimitSeconds = Math.max(1, Math.floor(limitSeconds));
    const current =
      this.ctx.storage.sql
        .exec<{ reserved_seconds: number }>(
          "SELECT reserved_seconds FROM daily_budget WHERE utc_date = ?",
          utcDate,
        )
        .toArray()[0]?.reserved_seconds ?? 0;

    if (current + safeRequestedSeconds > safeLimitSeconds) {
      return {
        allowed: false,
        limitSeconds: safeLimitSeconds,
        reservedSeconds: current,
      };
    }

    const reservedSeconds = current + safeRequestedSeconds;
    this.ctx.storage.sql.exec(
      `INSERT INTO daily_budget (utc_date, reserved_seconds)
       VALUES (?, ?)
       ON CONFLICT(utc_date) DO UPDATE SET reserved_seconds = excluded.reserved_seconds`,
      utcDate,
      reservedSeconds,
    );
    this.ctx.storage.sql.exec("DELETE FROM daily_budget WHERE utc_date < ?", utcDate);

    return {
      allowed: true,
      limitSeconds: safeLimitSeconds,
      reservedSeconds,
    };
  }

  stats(utcDate: string, limitSeconds: number): BudgetStats {
    const safeLimitSeconds = Math.max(1, Math.floor(limitSeconds));
    const reservedSeconds = this.getReservedSeconds(utcDate);
    return {
      utcDate,
      limitSeconds: safeLimitSeconds,
      reservedSeconds,
      remainingSeconds: Math.max(0, safeLimitSeconds - reservedSeconds),
    };
  }

  private getReservedSeconds(utcDate: string): number {
    return (
      this.ctx.storage.sql
        .exec<{ reserved_seconds: number }>(
          "SELECT reserved_seconds FROM daily_budget WHERE utc_date = ?",
          utcDate,
        )
        .toArray()[0]?.reserved_seconds ?? 0
    );
  }
}
