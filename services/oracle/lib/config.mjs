const normalize = (value, fallback) => String(value || fallback).replace(/\/$/, "");

export const resolveOracleConfig = () => ({
  port: Number.parseInt(process.env.SCRIPTARR_ORACLE_PORT || "3001", 10),
  sageBaseUrl: normalize(process.env.SCRIPTARR_SAGE_BASE_URL, "http://127.0.0.1:3004"),
  serviceToken: process.env.SCRIPTARR_SERVICE_TOKEN || process.env.SCRIPTARR_ORACLE_SERVICE_TOKEN || "oracle-dev-token",
  openAiModel: process.env.SCRIPTARR_ORACLE_OPENAI_MODEL || "gpt-4.1-mini",
  openAiApiKey: process.env.SCRIPTARR_OPENAI_API_KEY || "",
  localAiBaseUrl: normalize(process.env.SCRIPTARR_LOCALAI_BASE_URL, "http://127.0.0.1:8080/v1"),
  localAiApiKey: process.env.SCRIPTARR_LOCALAI_API_KEY || "localai",
  model: process.env.SCRIPTARR_ORACLE_MODEL || process.env.SCRIPTARR_ORACLE_OPENAI_MODEL || "gpt-4.1-mini",
  temperature: Number.parseFloat(process.env.SCRIPTARR_ORACLE_TEMPERATURE || "0.2"),
  noonaPersonaName: process.env.SCRIPTARR_NOONA_PERSONA_NAME || "Noona"
});
