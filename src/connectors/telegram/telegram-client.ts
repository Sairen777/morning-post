import { TelegramClient } from "telegram";
import input from "input";
import qrcode from "qrcode-terminal";
import {
  createClientFromSession,
  destroyTelegramClient,
  readTelegramApiCredentials,
  type TelegramApiCredentials,
} from "./client-factory.ts";
import { sanitizeErrorForOps } from "../../server/error-sanitizer.ts";

export function logTelegramClientError(error: unknown): void {
  console.error("QR login error:", sanitizeErrorForOps(error));
}
export interface CreateTelegramClientDependencies {
  acquireClient?: (sessionString: string) => Promise<TelegramClient>;
  readCredentials?: () => TelegramApiCredentials;
}

export async function createTelegramClient(
  dependencies: CreateTelegramClientDependencies = {},
): Promise<TelegramClient> {
  const sessionString = Deno.env.get("TELEGRAM_SESSION") ?? "";
  const { apiId, apiHash } = (dependencies.readCredentials ??
    readTelegramApiCredentials)();
  const client = await (dependencies.acquireClient ?? createClientFromSession)(
    sessionString,
  );

  try {
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
  } catch (error) {
    try {
      await destroyTelegramClient(client);
    } catch (cleanupError) {
      console.error(
        "Failed to destroy Telegram client after authorization failure:",
        sanitizeErrorForOps(cleanupError),
      );
      // Preserve the authorization failure; it is the actionable error.
    }
    throw error;
  }
}
