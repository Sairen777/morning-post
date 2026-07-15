import { TelegramClient } from "telegram";
import input from "input";
import qrcode from "qrcode-terminal";
import { createClientFromSession, readTelegramApiCredentials } from "./client-factory.ts";
import { sanitizeErrorForOps } from "../../server/error-sanitizer.ts";

export function logTelegramClientError(error: unknown): void {
  console.error("QR login error:", sanitizeErrorForOps(error));
}
export async function createTelegramClient(): Promise<TelegramClient> {
  const sessionString = Deno.env.get("TELEGRAM_SESSION") ?? "";
  const { apiId, apiHash } = readTelegramApiCredentials();
  const client = await createClientFromSession(sessionString);

  if (!(await client.isUserAuthorized())) {
    console.log("Logging in via QR code...");
    await client.signInUserWithQrCode({ apiId, apiHash }, {
      qrCode: (code) => {
        const url = `tg://login?token=${code.token.toString("base64url")}`;
        console.log(
          "\nScan with Telegram: Settings → Devices → Link Desktop Device\n",
        );
        qrcode.generate(url, { small: true });

        return Promise.resolve();
      },
      password: async () => await input.text("Enter your 2FA password: "),
      onError: (err) => {
        logTelegramClientError(err);
        return Promise.resolve(true);
      },
    });
  }

  console.log("Telegram session string (save this to TELEGRAM_SESSION):");
  console.log(client.session.save());

  return client;
}
