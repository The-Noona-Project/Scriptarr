const ORACLE_SETTINGS_KEY = "oracle.settings";
const ORACLE_OPENAI_API_KEY_SECRET = "oracle.openai.apiKey";

const normalizeBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
};

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

export const resolveOracleRuntimeSettings = async ({config, vaultClient}) => {
  const [settingsResponse, secretResponse] = await Promise.all([
    vaultClient.getSetting(ORACLE_SETTINGS_KEY),
    vaultClient.getSecret(ORACLE_OPENAI_API_KEY_SECRET)
  ]);

  const settings = settingsResponse?.value || {};
  const openAiApiKey = normalizeString(secretResponse?.value, config.openAiApiKey);
  const temperature = Number.parseFloat(String(settings.temperature ?? config.temperature));

  return {
    enabled: normalizeBoolean(settings.enabled, false),
    provider: ["openai", "localai"].includes(normalizeString(settings.provider, "openai"))
      ? normalizeString(settings.provider, "openai")
      : "openai",
    model: normalizeString(settings.model, config.model),
    temperature: Number.isFinite(temperature) ? temperature : config.temperature,
    openAiApiKeyConfigured: Boolean(openAiApiKey),
    localAiProfileKey: normalizeString(settings.localAiProfileKey, "nvidia"),
    localAiImageMode: normalizeString(settings.localAiImageMode, "preset"),
    localAiCustomImage: normalizeString(settings.localAiCustomImage, ""),
    localAiBaseUrl: config.localAiBaseUrl,
    localAiApiKey: config.localAiApiKey,
    openAiApiKey,
    apiKey: normalizeString(settings.provider, "openai") === "localai" ? config.localAiApiKey : openAiApiKey
  };
};

