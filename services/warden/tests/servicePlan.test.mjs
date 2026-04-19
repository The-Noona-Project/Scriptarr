import test from "node:test";
import assert from "node:assert/strict";

import {resolveServicePlan} from "../config/servicePlan.mjs";

test("service plan exposes the fixed Scriptarr network and selfhost mysql by default", () => {
  const plan = resolveServicePlan({
    env: {
      SCRIPTARR_MYSQL_URL: "SELFHOST",
      SCRIPTARR_MYSQL_USER: "scriptarr",
      SCRIPTARR_MYSQL_PASSWORD: "secret"
    }
  });

  assert.equal(plan.managedNetworkName, "scriptarr-network");
  assert.equal(plan.stackMode, "production");
  assert.equal(plan.mysql.mode, "selfhost");
  assert.equal(plan.services.some((service) => service.name === "scriptarr-mysql"), true);
  assert.equal(plan.services.find((service) => service.name === "scriptarr-moon").publishedPorts[0].hostPort, 3000);
});

test("service plan omits managed mysql for external mysql urls", () => {
  const plan = resolveServicePlan({
    env: {
      SCRIPTARR_MYSQL_URL: "mysql://db.example.com:3308/scriptarr",
      SCRIPTARR_MYSQL_USER: "external-user",
      SCRIPTARR_MYSQL_PASSWORD: "external-password",
      SCRIPTARR_WARDEN_BASE_URL: "http://host.docker.internal:4101"
    },
    containerNamePrefix: "scriptarr-test-demo"
  });

  assert.equal(plan.mysql.mode, "external");
  assert.equal(plan.services.some((service) => service.name === "scriptarr-mysql"), false);
  assert.equal(plan.services.find((service) => service.name === "scriptarr-vault").env.SCRIPTARR_MYSQL_HOST, "db.example.com");
  assert.equal(plan.services.find((service) => service.name === "scriptarr-sage").env.SCRIPTARR_WARDEN_BASE_URL, "http://host.docker.internal:4101");
  assert.match(plan.services.find((service) => service.name === "scriptarr-vault").containerName, /^scriptarr-test-demo-vault$/);
});
