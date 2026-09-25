// Runs once when a server instance starts. Validating here makes a bad deployment
// fail loudly in the logs at boot instead of on Meera's first note.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getConfig } = await import("@/lib/config");
  const { createLogger } = await import("@/lib/logger");
  const logger = createLogger({ service: "meera-content-bot" });
  try {
    getConfig();
    logger.info("startup.config_ok");
  } catch (error) {
    logger.error("startup.config_invalid", { error: (error as Error).message });
    throw error;
  }
}
