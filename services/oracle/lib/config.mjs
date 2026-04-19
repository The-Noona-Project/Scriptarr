const normalize = (value, fallback) => String(value || fallback).replace(/\/$/, "");

export const resolveOracleConfig = () => ({
  port: Number.parseInt(process.env.SCRIPTARR_ORACLE_PORT || "3001", 10),
  vaultBaseUrl: normalize(process.env.SCRIPTARR_VAULT_BASE_URL, "http://127.0.0.1:3005"),
  serviceToken: process.env.SCRIPTARR_SERVICE_TOKEN || process.env.SCRIPTARR_ORACLE_SERVICE_TOKEN || "oracle-dev-token",
  openAiModel: process.env.SCRIPTARR_ORACLE_OPENAI_MODEL || "gpt-4.1-mini",
  openAiApiKey: process.env.SCRIPTARR_OPENAI_API_KEY || "",
  localAiBaseUrl: normalize(process.env.SCRIPTARR_LOCALAI_BASE_URL, "http://127.0.0.1:8080/v1"),
  localAiApiKey: process.env.SCRIPTARR_LOCALAI_API_KEY || "localai",
  model: process.env.SCRIPTARR_ORACLE_MODEL || process.env.SCRIPTARR_ORACLE_OPENAI_MODEL || "gpt-4.1-mini",
  temperature: Number.parseFloat(process.env.SCRIPTARR_ORACLE_TEMPERATURE || "0.2"),
  wardenBaseUrl: normalize(process.env.SCRIPTARR_WARDEN_BASE_URL, "http://127.0.0.1:4001"),
  noonaPersonaName: process.env.SCRIPTARR_NOONA_PERSONA_NAME || "Noona"
});
