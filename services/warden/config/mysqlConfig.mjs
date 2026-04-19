/**
 * @file Scriptarr Warden module: services/warden/config/mysqlConfig.mjs.
 */
import {
  DEFAULT_MYSQL_DATABASE,
  DEFAULT_MYSQL_PASSWORD,
  DEFAULT_MYSQL_PORT,
  DEFAULT_MYSQL_USER,
  MYSQL_SELFHOST_VALUE
} from "./constants.mjs";

const normalizeString = (value) => String(value ?? "").trim();

const decodeSegment = (value) => decodeURIComponent(normalizeString(value));

/**
 * Error raised when the URL-first MySQL contract is malformed.
 */
export class MysqlConfigError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message);
    this.name = "MysqlConfigError";
  }
}

/**
 * Parse a `mysql://` URL and normalize the Scriptarr runtime fields that Warden
 * injects into managed services.
 *
 * @param {string} value
 * @param {{fallbackUser?: string, fallbackPassword?: string}} [options]
 * @returns {{
 *   mode: "external",
 *   rawUrl: string,
 *   host: string,
 *   port: number,
 *   database: string,
 *   user: string,
 *   password: string,
 *   passwordConfigured: boolean
 * }}
 */
export const parseMysqlUrl = (value, {fallbackUser = DEFAULT_MYSQL_USER, fallbackPassword = DEFAULT_MYSQL_PASSWORD} = {}) => {
  const rawUrl = normalizeString(value);
  if (!rawUrl) {
    throw new MysqlConfigError("SCRIPTARR_MYSQL_URL is required.");
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new MysqlConfigError(`SCRIPTARR_MYSQL_URL must be SELFHOST or a valid mysql:// URL. ${error instanceof Error ? error.message : String(error)}`);
  }

  if (parsed.protocol !== "mysql:") {
    throw new MysqlConfigError("SCRIPTARR_MYSQL_URL must use the mysql:// protocol.");
  }

  const host = normalizeString(parsed.hostname);
  const database = normalizeString(parsed.pathname.replace(/^\/+/, ""));
  const user = decodeSegment(parsed.username) || normalizeString(fallbackUser) || DEFAULT_MYSQL_USER;
  const password = decodeSegment(parsed.password) || normalizeString(fallbackPassword) || DEFAULT_MYSQL_PASSWORD;
  const parsedPort = Number.parseInt(normalizeString(parsed.port), 10);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_MYSQL_PORT;

  if (!host) {
    throw new MysqlConfigError("SCRIPTARR_MYSQL_URL must include a MySQL host.");
  }

  if (!database) {
    throw new MysqlConfigError("SCRIPTARR_MYSQL_URL must include a database name.");
  }

  return {
    mode: "external",
    rawUrl,
    host,
    port,
    database,
    user,
    password,
    passwordConfigured: Boolean(password)
  };
};

/**
 * Resolve the Warden MySQL contract. `SELFHOST` means Warden manages the MySQL
 * container; otherwise Warden validates and parses an external `mysql://` URL.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{
 *   mode: "selfhost" | "external",
 *   rawUrl: string,
 *   host: string,
 *   port: number,
 *   database: string,
 *   user: string,
 *   password: string,
 *   passwordConfigured: boolean,
 *   managedServiceName: string | null
 * }}
 */
export const resolveMysqlConfig = ({env = process.env} = {}) => {
  const rawUrl = normalizeString(env.SCRIPTARR_MYSQL_URL || MYSQL_SELFHOST_VALUE) || MYSQL_SELFHOST_VALUE;
  const fallbackUser = normalizeString(env.SCRIPTARR_MYSQL_USER || DEFAULT_MYSQL_USER) || DEFAULT_MYSQL_USER;
  const fallbackPassword = normalizeString(env.SCRIPTARR_MYSQL_PASSWORD || DEFAULT_MYSQL_PASSWORD) || DEFAULT_MYSQL_PASSWORD;

  if (rawUrl.toUpperCase() === MYSQL_SELFHOST_VALUE) {
    return {
      mode: "selfhost",
      rawUrl: MYSQL_SELFHOST_VALUE,
      host: "scriptarr-mysql",
      port: DEFAULT_MYSQL_PORT,
      database: DEFAULT_MYSQL_DATABASE,
      user: fallbackUser,
      password: fallbackPassword,
      passwordConfigured: Boolean(fallbackPassword),
      managedServiceName: "scriptarr-mysql"
    };
  }

  const external = parseMysqlUrl(rawUrl, {
    fallbackUser,
    fallbackPassword
  });

  return {
    ...external,
    managedServiceName: null
  };
};

/**
 * Convert the resolved MySQL runtime into the split environment variables still
 * expected by Vault and the other internal services.
 *
 * @param {{
 *   host: string,
 *   port: number,
 *   database: string,
 *   user: string,
 *   password: string
 * }} mysqlConfig
 * @returns {{
 *   SCRIPTARR_MYSQL_HOST: string,
 *   SCRIPTARR_MYSQL_PORT: string,
 *   SCRIPTARR_MYSQL_DATABASE: string,
 *   SCRIPTARR_MYSQL_USER: string,
 *   SCRIPTARR_MYSQL_PASSWORD: string
 * }}
 */
export const toInternalMysqlEnv = (mysqlConfig) => ({
  SCRIPTARR_MYSQL_HOST: mysqlConfig.host,
  SCRIPTARR_MYSQL_PORT: String(mysqlConfig.port),
  SCRIPTARR_MYSQL_DATABASE: mysqlConfig.database,
  SCRIPTARR_MYSQL_USER: mysqlConfig.user,
  SCRIPTARR_MYSQL_PASSWORD: mysqlConfig.password
});

