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

The app authenticates via QR code on first run and prints a session string so you don't have to log in again. Run the app `deno task dev`.

1. Leave `TELEGRAM_SESSION` empty in your `.env` file
2. Run `deno task dev`
3. Scan the QR code in Telegram: **Settings → Devices → Link Desktop Device**
4. The session string will be printed to the console — copy it
5. Set it in your `.env` file:
   ```
   TELEGRAM_SESSION=your_session_string
   ```

After this, the app will reuse the session without prompting again.
