/**
 * @file Test optional service-scoped DNS configuration and safe Docker arguments.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {containerDnsArguments, containerDnsMatchesInspect, resolveServiceDnsServers} from "../config/containerDns.mjs";
import {resolveServicePlan} from "../config/servicePlan.mjs";

test("unset service DNS emits no flags and preserves existing Docker resolver settings", () => {
  for (const value of [undefined, "", "  "]) {
    const servers = resolveServiceDnsServers("scriptarr-raven", {SCRIPTARR_RAVEN_DNS_SERVERS: value});
    assert.equal(servers, undefined);
    assert.deepEqual(containerDnsArguments(servers), []);
    assert.equal(containerDnsMatchesInspect(servers, {HostConfig: {Dns: ["192.168.50.1"]}}), true);
  }
});

test("service DNS validates IPv4 and IPv6, retains priority and deduplicates equivalent addresses", () => {
  const servers = resolveServiceDnsServers("scriptarr-raven", {SCRIPTARR_RAVEN_DNS_SERVERS: "1.1.1.1,8.8.8.8 2001:0db8:0:0:0:0:0:53,2001:db8::53"});
  assert.deepEqual(servers, ["1.1.1.1", "8.8.8.8", "2001:db8::53"]);
  assert.deepEqual(containerDnsArguments(servers), ["--dns", "1.1.1.1", "--dns", "8.8.8.8", "--dns", "2001:db8::53"]);
  assert.equal(containerDnsMatchesInspect(servers, {HostConfig: {Dns: [...servers]}}), true);
  assert.equal(containerDnsMatchesInspect(servers, {HostConfig: {Dns: ["8.8.8.8", "1.1.1.1", "2001:db8::53"]}}), false);
});

test("an explicit empty JSON list restores inherited DNS instead of leaving an override unmanaged", () => {
  const servers = resolveServiceDnsServers("scriptarr-raven", {SCRIPTARR_RAVEN_DNS_SERVERS: "[]"});
  assert.deepEqual(servers, []);
  assert.deepEqual(containerDnsArguments(servers), []);
  assert.equal(containerDnsMatchesInspect(servers, {HostConfig: {Dns: ["1.1.1.1"]}}), false);
  assert.equal(containerDnsMatchesInspect(servers, {HostConfig: {Dns: []}}), true);
});

test("invalid resolver names, flags, malformed JSON and non-string entries fail closed", () => {
  for (const value of ["localhost", "1.1.1.1 --privileged", "1.1.1.1;whoami", "[", "[1]", "{}", ",,"]) {
    assert.throws(() => resolveServiceDnsServers("scriptarr-raven", {SCRIPTARR_RAVEN_DNS_SERVERS: value}), /SCRIPTARR_RAVEN_DNS_SERVERS/);
  }
  assert.throws(() => containerDnsArguments(["--privileged"]), /resolver IP/);
});

test("a Raven-only override changes no other service descriptor or application environment", () => {
  const env = {SCRIPTARR_MYSQL_URL: "SELFHOST", SCRIPTARR_MYSQL_USER: "app", SCRIPTARR_MYSQL_PASSWORD: "fixture", SCRIPTARR_GPU_HINT: "cpu"};
  const baseline = resolveServicePlan({env});
  const configured = resolveServicePlan({env: {...env, SCRIPTARR_RAVEN_DNS_SERVERS: '["1.1.1.1","8.8.8.8"]'}});
  for (const service of configured.services) {
    const previous = baseline.services.find((entry) => entry.name === service.name);
    if (service.name === "scriptarr-raven") {
      assert.deepEqual(service.dnsServers, ["1.1.1.1", "8.8.8.8"]);
      const {dnsServers, ...unchanged} = service;
      assert.deepEqual(unchanged, previous);
    } else assert.deepEqual(service, previous);
  }
});
