/** @file Run the LAN policy against a command recorder, without changing host rules. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";

const execute = promisify(execFile);
const policy = fileURLToPath(new URL("../deployment/lan-policy.sh", import.meta.url));
const bash = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/bash";

const record = async host => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "scriptarr-policy-test-"));
  const log = path.join(directory, "rules.log");
  try {
    const commands = {
      id: "printf '0\\n'",
      seq: "printf '1\\n'",
      iptables: "printf '%s\\n' \"$*\" >> \"$POLICY_TEST_LOG\"\ncase \" $* \" in *' -C '*) return 1;; esac"
    };
    const mocks = Object.entries(commands).map(([name, body]) => `${name}() {\n${body}\n}`).join("\n");
    await execute(bash, ["-c", `${mocks}\nsource \"$1\" \"$2\"`, "scriptarr-lan-policy-test", policy.replaceAll("\\", "/"), host], {
      env: {...process.env, POLICY_TEST_LOG: log.replaceAll("\\", "/")}, timeout: 10000
    });
    return (await fs.readFile(log, "utf8")).trim().split(/\r?\n/);
  } finally {
    // The absolute target comes directly from mkdtemp in the OS temporary directory.
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(directory, {recursive: true, force: true});
  }
};

test("core worker port permits only the AI host and preserves the existing LAN port rules", async () => {
  const rows = await record("core");
  const worker = rows.filter(row => row.includes("--ctorigdstport 3444"));
  assert.deepEqual(worker, [
    "-w 5 -A SCRIPTARR-LAN -p tcp -m conntrack --ctorigsrc 192.168.50.7 --ctorigdst 192.168.50.6 --ctorigdstport 3444 -j ACCEPT",
    "-w 5 -A SCRIPTARR-LAN -p tcp -m conntrack --ctorigdst 192.168.50.6 --ctorigdstport 3444 -j DROP"
  ]);
  assert.equal(rows.filter(row => row.includes("--ctorigdstport 3004") && row.endsWith("-j ACCEPT")).length, 2);
  assert.equal(rows.filter(row => row.includes("--ctorigdstport 4401") && row.endsWith("-j ACCEPT")).length, 1);
  assert.ok(rows.includes("-w 5 -I DOCKER-USER 1 -j SCRIPTARR-LAN"));
  assert.equal(rows.filter(row => / -F /.test(row)).join(), "-w 5 -F SCRIPTARR-LAN");
});

test("AI host policy has no new listener or worker-port permission", async () => {
  const rows = await record("ai");
  assert.equal(rows.some(row => row.includes("3444")), false);
  for (const port of [3001, 3003]) assert.equal(rows.filter(row => row.includes(`--ctorigdstport ${port}`) && row.endsWith("-j ACCEPT")).length, 3);
});
