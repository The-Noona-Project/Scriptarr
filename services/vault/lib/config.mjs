export const resolveVaultConfig = () => ({
  port: Number.parseInt(process.env.SCRIPTARR_VAULT_PORT || "3005", 10),
  driver: process.env.SCRIPTARR_VAULT_DRIVER || "mysql",
  mysql: {
    host: process.env.SCRIPTARR_MYSQL_HOST || "127.0.0.1",
    port: Number.parseInt(process.env.SCRIPTARR_MYSQL_PORT || "3306", 10),
    user: process.env.SCRIPTARR_MYSQL_USER || "scriptarr",
    password: process.env.SCRIPTARR_MYSQL_PASSWORD || "scriptarr-dev-password",
    database: process.env.SCRIPTARR_MYSQL_DATABASE || "scriptarr"
  },
  serviceTokens: JSON.parse(process.env.SCRIPTARR_SERVICE_TOKENS || "{}"),
  autoProvision: process.env.SCRIPTARR_AUTO_PROVISION_DISCORD_USERS !== "false"
});
