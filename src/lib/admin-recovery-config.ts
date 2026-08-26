import "server-only";

const deployedTokenHash = "UI9wNaQq1-u8XtUqO3l1PkvCq7ZfJlCkqeWMOPBE-iE";
const deployedExpiresAt = "2026-08-27T18:50:52.849Z";

export function adminRecoveryConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  return {
    tokenHash: env.BUBBLEWASH_ADMIN_RECOVERY_TOKEN_HASH?.trim() || deployedTokenHash,
    expiresAt: env.BUBBLEWASH_ADMIN_RECOVERY_EXPIRES_AT?.trim() || deployedExpiresAt,
  };
}
