import "server-only";

const deployedTokenHash = "WttrKecrbhKncFM_AnHhrRALq8z55eMwb4l_kpaQM-U";
const deployedExpiresAt = "2026-08-30T16:09:07.195Z";

export function adminRecoveryConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env) {
  return {
    tokenHash: env.BUBBLEWASH_ADMIN_RECOVERY_TOKEN_HASH?.trim() || deployedTokenHash,
    expiresAt: env.BUBBLEWASH_ADMIN_RECOVERY_EXPIRES_AT?.trim() || deployedExpiresAt,
  };
}
