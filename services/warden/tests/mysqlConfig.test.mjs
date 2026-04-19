/**
 * @file Scriptarr Warden module: services/warden/tests/mysqlConfig.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {MysqlConfigError, parseMysqlUrl, resolveMysqlConfig, toInternalMysqlEnv} from "../config/mysqlConfig.mjs";

test("resolve mysql config defaults to selfhost", () => {
  const config = resolveMysqlConfig({
    env: {
      SCRIPTARR_MYSQL_USER: "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: "secret"
    }
  });

  assert.equal(config.mode, "selfhost");
  assert.equal(config.host, "scriptarr-mysql");
  assert.equal(config.database, "scriptarr");
  assert.equal(config.user, "scriptarr");
  assert.equal(config.password, "secret");
  assert.equal(config.managedServiceName, "scriptarr-mysql");
});

test("parse mysql url falls back to SCRIPTARR_MYSQL_USER when the URL omits a username", () => {
  const config = parseMysqlUrl("mysql://db.example.com:3307/scriptarr", {
    fallbackUser: "vault-user",
    fallbackPassword: "vault-password"
  });

  assert.deepEqual(toInternalMysqlEnv(config), {
    SCRIPTARR_MYSQL_HOST: "db.example.com",
    SCRIPTARR_MYSQL_PORT: "3307",
    SCRIPTARR_MYSQL_DATABASE: "scriptarr",
    SCRIPTARR_MYSQL_USER: "vault-user",
    SCRIPTARR_MYSQL_PASSWORD: "vault-password"
  });
});

test("parse mysql url rejects non-mysql protocols", () => {
  assert.throws(
    () => parseMysqlUrl("postgres://db.example.com/scriptarr"),
    MysqlConfigError
  );
});

