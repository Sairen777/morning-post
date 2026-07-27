import type { Database } from "../db/client.ts";
import { verifyPassword } from "../auth/password.ts";
import { findOwner, type User } from "../repositories/user-repository.ts";

/**
 * Precomputed argon2id dummy hash for timing-constant comparison when no owner
 * exists. Generated with the same parameters as `hashPassword` (memory 19456
 * KiB, iterations 2, parallelism 1, hashLength 32).
 */
export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$Hhlulm2pzt1XQKrP3vVeIff6PWoAuycp6w6Gs+P+/6A";

export interface AuthenticateOwnerInput {
  password?: string;
}


export async function authenticateOwner(
  database: Database,
  input: AuthenticateOwnerInput,
): Promise<User | null> {
  const user = await findOwner(database);

  if (user?.passwordHash === null) {
    return user;
  }

  const password = input.password ?? "";
  const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const passwordMatches = await verifyPassword(password, passwordHash);
  if (!user || password.length === 0 || !passwordMatches) {
    return null;
  }
  return user;
}
