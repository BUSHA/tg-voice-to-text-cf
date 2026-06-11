import { Buffer } from "node:buffer";
import { DurableObject } from "cloudflare:workers";

const PRIVATE_CHAT_HELP =
  "Send me a voice message and I’ll convert it to text.";
const TOO_LARGE_MESSAGE =
  "This voice message is too large to transcribe. Please send a shorter one.";
const EMPTY_TRANSCRIPTION_MESSAGE =
  "I couldn’t recognize speech in this voice message.";
const TEMPORARY_ERROR_MESSAGE =
  "Sorry, I couldn’t transcribe this voice message. Please try again.";
const DAILY_LIMIT_MESSAGE =
  "The daily transcription limit has been reached. Please try again after 00:00 UTC.";
const NOT_ALLOWED_MESSAGE =
  "This chat is not allowed to use voice transcription.";
const GUEST_NOT_ALLOWED_MESSAGE =
  "You are not allowed to use voice transcription.";
const GUEST_HELP_MESSAGE =
  "Reply to a voice or audio message when mentioning me, and I’ll transcribe it.";
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
      return new Response("Telegram transcription bot is running");
    }

    const webhookSecret = getPathSecret(url.pathname);
    if (request.method !== "POST" || webhookSecret === undefined) {
      return new Response("Not found", { status: 404 });
    }

    if (webhookSecret !== env.WEBHOOK_SECRET) {
      return new Response("Not found", { status: 404 });
    }

    let update: TelegramUpdate;
    try {
      update = await request.json<TelegramUpdate>();
    } catch (error) {
      logError("Invalid Telegram webhook JSON", error);
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
      `Chat ID: ${message.chat.id}`,
      message.message_id,
    );
    return;
  }

  const config = getRuntimeConfig(env);
  if (
    message.chat.type === "private" &&
    !config.allowPrivateChats &&
    !config.allowedChatIds.has(String(message.chat.id))
  ) {
    console.warn({
      message: "Ignored update from a private chat",
      chatId: message.chat.id,
    });
    if (message.voice || message.audio) {
      await safelySendMessage(env, message.chat.id, NOT_ALLOWED_MESSAGE, message.message_id);
    }
    return;
  }

  if (!isAllowedChat(config.allowedChatIds, message.chat.id)) {
    console.warn({
      message: "Ignored update from a chat that is not allowlisted",
      chatId: message.chat.id,
      chatType: message.chat.type,
    });
    if (message.voice || message.audio) {
      await safelySendMessage(env, message.chat.id, NOT_ALLOWED_MESSAGE, message.message_id);
    }
    return;
  }

  if (message.text?.match(/^\/stats(?:@\w+)?$/)) {
    try {
      const stats = await getDailyBudgetStats(env, config.dailyTranscriptionSeconds);
      await sendMessage(env, message.chat.id, formatBudgetStats(stats), message.message_id);
    } catch (error) {
      logError("Failed to retrieve daily budget stats", error);
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
      logError("Failed to enable Telegram guest updates", error);
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
      logError("Failed to retrieve Telegram guest status", error);
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
    message: "Received transcribable Telegram message",
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
      throw new TelegramApiError("Telegram getFile response did not include file_path");
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

    logError("Voice transcription failed", error);
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
      message: "Rejected guest query from a user that is not allowlisted",
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
    message: "Received transcribable Telegram guest query",
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
      throw new TelegramApiError("Telegram getFile response did not include file_path");
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

    logError("Guest voice transcription failed", error);
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
    `Daily transcription usage (${stats.utcDate} UTC):`,
    `Used: ${formatMinutes(stats.reservedSeconds)}`,
    `Remaining: ${formatMinutes(stats.remainingSeconds)}`,
    `Limit: ${formatMinutes(stats.limitSeconds)}`,
    "Resets at 00:00 UTC.",
  ].join("\n");
}

function formatMinutes(seconds: number): string {
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minutes`;
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
    throw new TelegramApiError(`Telegram ${method} returned invalid JSON`, response.status);
  }

  if (!response.ok || !body.ok || body.result === undefined) {
    throw new TelegramApiError(
      `Telegram ${method} failed: ${body.description ?? response.statusText}`,
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
    logError("Failed to send Telegram message", error);
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
  const allowedUpdates = webhook.allowed_updates?.join(", ") || "all default updates";
  return [
    `Bot: @${bot.username ?? "unknown"}`,
    `Guest Mode capability: ${bot.supports_guest_queries === true ? "enabled" : "NOT enabled"}`,
    `Webhook guest_message subscription: ${
      webhook.allowed_updates?.includes("guest_message") ? "enabled" : "NOT enabled"
    }`,
    `Webhook updates: ${allowedUpdates}`,
    `Pending updates: ${webhook.pending_update_count}`,
    ...(webhook.last_error_message
      ? [`Last webhook error: ${webhook.last_error_message}`]
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
      title: "Voice transcription",
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
    logError("Failed to answer Telegram guest query", error);
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
    throw new TelegramApiError("Telegram file download failed", response.status);
  }

  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxFileSizeBytes) {
    throw new RangeError("Telegram file exceeds configured maximum size");
  }

  const audio = await response.arrayBuffer();
  if (audio.byteLength > maxFileSizeBytes) {
    throw new RangeError("Telegram file exceeds configured maximum size");
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
    throw new Error(`Unsupported WHISPER_MODEL: ${config.model}`);
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
