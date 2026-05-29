-- Drop legacy models that are no longer referenced by runtime:
--   * AdminUser, AdminRole — REST/JWT admin removed in Phase 2 (long ago)
--   * Tenant, BotConfiguration, PromptProfile — multi-tenant table heritage,
--     never wired into runtime (file-based configs only)
--   * HandoffEvent — handoff functionality not implemented post-Phase 6
DROP TABLE IF EXISTS "AdminUser";
DROP TABLE IF EXISTS "BotConfiguration";
DROP TABLE IF EXISTS "PromptProfile";
DROP TABLE IF EXISTS "Tenant";
DROP TABLE IF EXISTS "HandoffEvent";
DROP TYPE IF EXISTS "AdminRole";
