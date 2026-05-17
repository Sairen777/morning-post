import { TelegramClient } from "npm:telegram@^2.26.22";
import { StringSession } from "npm:telegram@^2.26.22/sessions/index.js";
import input from "npm:input@^1.0.1";
import qrcode from "npm:qrcode-terminal@^0.12.0";

const API_ID = Number(Deno.env.get("TELEGRAM_API_ID"));
const API_HASH = Deno.env.get("TELEGRAM_API_HASH") ?? "";
const SESSION_STRING = Deno.env.get("TELEGRAM_SESSION") ?? "";

export async function createTelegramClient(): Promise<TelegramClient> {
  const session = new StringSession(SESSION_STRING);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.connect();

  if (!(await client.isUserAuthorized())) {
    console.log("Logging in via QR code...");
    await client.signInUserWithQrCode(
      { apiId: API_ID, apiHash: API_HASH },
      {
        qrCode: async (code) => {
          const url = `tg://login?token=${code.token.toString("base64url")}`;
          console.log(
            "\nScan with Telegram: Settings → Devices → Link Desktop Device\n",
          );
          qrcode.generate(url, { small: true });
        },
        password: async () => await input.text("Enter your 2FA password: "),
        onError: async (err) => {
          console.error("QR login error:", err);
          return true;
        },
      },
    );
  }

  console.log("Telegram session string (save this to TELEGRAM_SESSION):");
  console.log(client.session.save());

  return client;
}
