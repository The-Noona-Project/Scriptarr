/**
 * Shared Warden defaults used across runtime planning, Docker orchestration,
 * and the repo-level developer helpers.
 */

export const DEFAULT_IMAGE_NAMESPACE =
  process.env.SCRIPTARR_IMAGE_NAMESPACE || "docker.darkmatterservers.com/the-noona-project";

export const DEFAULT_IMAGE_TAG = process.env.SCRIPTARR_IMAGE_TAG || "latest";

export const DEFAULT_NETWORK_NAME = "scriptarr-network";

export const DEFAULT_STACK_MODE = "production";

export const DEFAULT_PUBLIC_BASE_URL = "http://localhost:3000";

export const DEFAULT_WARDEN_PORT = 4001;

export const DEFAULT_MOON_PORT = 3000;

export const DEFAULT_MOON_PUBLIC_PORT = 3000;

export const DEFAULT_SAGE_PORT = 3004;

export const DEFAULT_VAULT_PORT = 3005;

export const DEFAULT_PORTAL_PORT = 3003;

export const DEFAULT_ORACLE_PORT = 3001;

export const DEFAULT_RAVEN_PORT = 8080;

export const DEFAULT_MYSQL_PORT = 3306;

export const DEFAULT_MYSQL_DATABASE = "scriptarr";

export const DEFAULT_MYSQL_USER = "scriptarr";

export const DEFAULT_MYSQL_PASSWORD = "scriptarr-dev-password";

export const MYSQL_SELFHOST_VALUE = "SELFHOST";

export const DEFAULT_WARDEN_SERVICE_BASE_URL = "http://scriptarr-warden:4001";

export const DEFAULT_LOCALAI_PORT = 8080;

export const DEFAULT_LOCALAI_CONTAINER_NAME = "scriptarr-localai";

export const DEFAULT_NOONA_PERSONA_NAME = "Noona";

export const DEFAULT_TEST_STACK_ID = "local";

export const DEFAULT_TEST_MOON_PORT = 3300;

export const DEFAULT_TEST_WARDEN_PORT = 4101;

export const DEFAULT_TEST_STATE_DIRECTORY_NAME = "scriptarr-warden-test-stacks";

export const DEFAULT_WARDEN_HOST_ALIAS = "host.docker.internal";

export const DEFAULT_UNIX_SCRIPTARR_DATA_ROOT = "/mnt/user/scriptarr";

export const FIRST_PARTY_SERVICE_NAMES = Object.freeze([
  "scriptarr-warden",
  "scriptarr-vault",
  "scriptarr-sage",
  "scriptarr-moon",
  "scriptarr-raven",
  "scriptarr-portal",
  "scriptarr-oracle"
]);

export const BUILDABLE_SERVICE_NAMES = Object.freeze(
  FIRST_PARTY_SERVICE_NAMES.filter((serviceName) => serviceName !== "scriptarr-warden")
);
