import { TelegramClient } from "telegram";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
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

async function promptForTwoFactorPassword(): Promise<string> {
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    return await readline.question("Enter your 2FA password: ");
  } finally {
    readline.close();
  }
}

export async function createTelegramClient(
  dependencies: CreateTelegramClientDependencies = {},
): Promise<TelegramClient> {
  const sessionString = process.env["TELEGRAM_SESSION"] ?? "";
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
        password: promptForTwoFactorPassword,
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
