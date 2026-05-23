const parseNonNegativeInteger = (value, fallback) => {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 ? normalized : fallback;
};

const parsePositiveInteger = (value, fallback) => {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
};

export const resolveVaultConfig = (env = process.env) => ({
  port: Number.parseInt(env.SCRIPTARR_VAULT_PORT || "3005", 10),
  driver: env.SCRIPTARR_VAULT_DRIVER || "mysql",
  mysql: {
    host: env.SCRIPTARR_MYSQL_HOST || "127.0.0.1",
    port: Number.parseInt(env.SCRIPTARR_MYSQL_PORT || "3306", 10),
    user: env.SCRIPTARR_MYSQL_USER || "scriptarr",
    password: env.SCRIPTARR_MYSQL_PASSWORD || "scriptarr-dev-password",
    database: env.SCRIPTARR_MYSQL_DATABASE || "scriptarr"
  },
  serviceTokens: JSON.parse(env.SCRIPTARR_SERVICE_TOKENS || "{}"),
  autoProvision: env.SCRIPTARR_AUTO_PROVISION_DISCORD_USERS !== "false",
  mysqlKeepAliveIntervalMs: parseNonNegativeInteger(env.SCRIPTARR_MYSQL_KEEPALIVE_INTERVAL_MS, 45000),
  slowStoreOperationMs: parsePositiveInteger(env.SCRIPTARR_VAULT_SLOW_STORE_OPERATION_MS, 2000)
});
