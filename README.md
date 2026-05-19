# Morning Post App

## Get Telegram Credentials

1. Open [https://my.telegram.org/apps](https://my.telegram.org/apps)
2. Log in with your Telegram account
3. Create a new app and note down the `API ID` and `API Hash`
4. Set them in your `.env` file:
   ```
   TELEGRAM_API_ID=your_api_id
   TELEGRAM_API_HASH=your_api_hash
   ```

## Get Telegram Session String

The app authenticates via QR code on first run and prints a session string so
you don't have to log in again. Run the app `deno task dev`.

1. Leave `TELEGRAM_SESSION` empty in your `.env` file
2. Run `deno task dev`
3. Scan the QR code in Telegram: **Settings → Devices → Link Desktop Device**
4. The session string will be printed to the console — copy it
5. Set it in your `.env` file:
   ```
   TELEGRAM_SESSION=your_session_string
   ```

## What the Telegram Connector Ignores

- **Polls** — messages whose only content is a poll (no text, no photo) are skipped
- **Stickers, reactions, and other media-only messages** — anything with no text and no photo/video/document/webpage is skipped

## Non-obvious Gotchas

**Groups vs channels detection**
Supergroups are technically `Api.Channel` in GramJS with a `megagroup: true` flag — checking `instanceof Api.Channel` alone does not distinguish them from broadcast channels. Basic groups are `Api.Chat`.

**Photos are not downloaded for groups**
Group chat photos are usually memes and would waste vision tokens. Photo download only runs for broadcast channels; group messages silently drop photo media.

**Pure emoji messages are filtered before summarization**
Messages with no letter characters (`👍`, `😂🔥`) are dropped. Short word replies like "yes" or "no" pass through since they contain letters.

**Quote fetching is best-effort**
Quoted/replied-to messages are batch-fetched after iteration and prepended as `[QUOTED_MESSAGE]...[/QUOTED_MESSAGE]`. If the fetch fails (e.g. deleted message, permission error), the main message is still kept — the quote is just omitted silently.

**Album grouping**
Photos sent as an album share the same `groupedId`. They are merged into a single item with `type: "album"` — only one of the album messages typically carries the caption text.

**Context overflow for large group chats**
All group messages are sent in a single summarizer request. Threads with 300+ messages may overflow the model's context window. See the comment in `openai-compatible-summarizer.ts` for options (hard cap, time-window cap, chunked summarization).

**Anonymous admins posting as the channel**
In supergroups, admins can post anonymously — their `message.sender` is the group's linked channel rather than a `User`. These show up with the channel title as the author name.
