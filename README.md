# Telegram Voice Transcriber

A Cloudflare Worker that receives Telegram voice messages, sends the original
`.ogg`/Opus audio directly to Cloudflare Workers AI Whisper, and replies with
the transcription. It uses no separate server, database, queue, or Cloudflare
API token.

## Behavior

- Handles Telegram `message.voice` and `message.audio`.
- Ignores bot messages.
- Replies to unsupported messages only in private chats.
- Rejects oversized or overlong audio before transcription.
- Restricts usage to an optional allowlist of Telegram chat IDs.
- Enforces an atomic daily transcription budget using a SQLite-backed Durable
  Object.
- Acknowledges webhooks immediately and finishes transcription with
  `ctx.waitUntil()` to avoid Telegram retries.
- Replies to the original message and splits transcriptions that exceed
  Telegram's 4096-character message limit.

## Prerequisites

- A Cloudflare account with Workers AI enabled.
- Node.js and npm.
- A Telegram bot token created by messaging [@BotFather](https://t.me/BotFather)
  and running `/newbot`.

## Setup

Install dependencies:

```sh
npm install
```

The Workers AI binding is configured in `wrangler.jsonc`:

```jsonc
"ai": {
  "binding": "AI"
}
```

Authenticate Wrangler and add the required secrets:

```sh
npx wrangler login
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

Use a long random value for `WEBHOOK_SECRET`. It becomes part of the webhook
URL and prevents callers who do not know it from invoking the bot endpoint.
Secrets are not stored in `wrangler.jsonc`.

Non-secret settings live under `vars` in `wrangler.jsonc`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ALLOW_PRIVATE_CHATS` | `false` | Ignore unlisted private chats when false |
| `ALLOWED_CHAT_IDS` | empty | Comma-separated allowed Telegram chat IDs; empty allows all |
| `DAILY_TRANSCRIPTION_SECONDS` | `6000` | Daily budget in seconds, reset at 00:00 UTC |
| `DEFAULT_LANGUAGE` | `uk` | Preferred ISO 639-1 language; empty means auto-detect |
| `MAX_FILE_SIZE_BYTES` | `20000000` | Maximum downloaded audio size |
| `MAX_DURATION_SECONDS` | `300` | Maximum Telegram-reported duration |
| `WHISPER_MODEL` | `@cf/openai/whisper-large-v3-turbo` | Workers AI model |

Supported model values are `@cf/openai/whisper-large-v3-turbo` and
`@cf/openai/whisper`. The default large-v3-turbo model accepts base64 audio and
receives `DEFAULT_LANGUAGE=uk`, which prevents Ukrainian speech from being
auto-detected as Russian. The older Whisper model accepts an audio byte array
but does not accept a language parameter, so selecting it always enables
language auto-detection. Both requests transcribe; neither translates.

Cloudflare currently marks `@cf/openai/whisper-large-v3-turbo` as deprecated,
so confirm its availability before selecting it.

## Usage Safeguards

The default daily budget is 6,000 seconds, or 100 minutes. This leaves roughly
114 minutes of headroom below the current estimated free allocation for
`@cf/openai/whisper-large-v3-turbo`. The bot reserves each message's
Telegram-reported duration before calling Workers AI. Failed transcription
attempts remain counted intentionally, favoring a conservative budget.

The budget is enforced atomically by the `DailyBudget` SQLite-backed Durable
Object and resets at 00:00 UTC. This protects this bot's usage. It cannot
account for Workers AI usage from other Workers in the same Cloudflare account,
so leave additional headroom if the account runs other AI workloads.

Allowed chats can send `/stats` to see the bot's reserved minutes used,
remaining minutes, daily limit, and UTC reset time. The command is ignored in
non-allowlisted chats and does not invoke Workers AI.

To restrict the bot to specific personal chats, groups, or supergroups, set
their numeric IDs in `wrangler.jsonc`:

```jsonc
"ALLOWED_CHAT_IDS": "123456789,-1001234567890"
```

Positive IDs are usually private chats. Group and supergroup IDs are usually
negative. The easiest way to discover one is to send `/chatid` in that personal
chat or group. The bot replies with its numeric ID. This command works even
when a group is not yet allowlisted.

Set `ALLOW_PRIVATE_CHATS` to `false` to silently ignore every personal message
from users whose positive private chat ID is not in `ALLOWED_CHAT_IDS`.
Explicitly allowlisted private chats remain usable. When private chats are
disabled, `/chatid` is also ignored for unlisted personal chats.

You can also temporarily leave `ALLOWED_CHAT_IDS` empty, send a voice message
in the chat, then inspect structured Worker logs:

```sh
npx wrangler tail
```

After adding the IDs, deploy again. Voice/audio messages from non-allowlisted
chats receive an access-denied reply without invoking Workers AI. Other
messages from those chats are silently ignored and logged.

## Verify And Deploy

Generate binding types, type-check, and perform a Wrangler dry run:

```sh
npm run verify
```

Deploy:

```sh
npm run deploy
```

The health check is available at:

```txt
https://<worker-domain>/
```

It returns `Telegram transcription bot is running`.

## Set The Telegram Webhook

After deploying, configure Telegram to send updates to the secret endpoint:

```sh
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<worker-domain>/telegram/<WEBHOOK_SECRET>"
```

Do not commit or share the resulting URL because it contains the webhook
secret.

## Enable Group Chats

Telegram enables Group Privacy Mode for bots by default. With privacy mode
enabled, Telegram does not send ordinary group voice messages to the bot's
webhook, so the Worker cannot transcribe them.

To receive every voice message in a group:

1. Open [@BotFather](https://t.me/BotFather).
2. Send `/setprivacy`.
3. Select this bot.
4. Select **Disable**.
5. Remove the bot from each existing group and add it again. Telegram requires
   re-adding the bot for the privacy change to take effect.

Alternatively, promote the bot to a group administrator. Telegram delivers all
group messages to bot administrators even when Group Privacy Mode is enabled.
The bot does not need any additional administrator permissions to transcribe
messages.

With privacy mode still enabled, the bot receives only limited group messages,
including commands explicitly addressed to it and messages that reply to one
of its messages.

## Test

1. Send `/start` in a private chat. The bot should ask for a voice message.
2. Send a short Ukrainian voice message.
3. Confirm the bot replies to it with `📝 <transcribed text>`.
4. After completing **Enable Group Chats**, send a voice message in a group and
   confirm the bot replies with text.
5. Send a non-voice message in a group and confirm the bot stays silent.

For local development, create an ignored `.dev.vars` file with
`TELEGRAM_BOT_TOKEN` and `WEBHOOK_SECRET`, then run `npm run dev`. Workers AI
uses your Cloudflare account and incurs usage even during local development.

## Audio Compatibility

Telegram voice messages are normally `.ogg` files containing Opus audio. This
Worker intentionally sends those bytes directly to Workers AI and does not run
`ffmpeg` or convert audio locally.

If Workers AI rejects a particular Telegram `.ogg`/Opus file, the bot sends a
temporary-error reply and logs the model error. A future version would need an
external audio-conversion service for those files; that is intentionally
outside this Workers-only MVP.

The optional `@cf/openai/whisper` model requires audio to be expanded into a
JavaScript number array. Near the configured 20 MB limit this can approach the
Worker's memory limit. The default `@cf/openai/whisper-large-v3-turbo` model
uses base64 instead.
