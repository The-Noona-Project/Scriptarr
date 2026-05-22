import assert from "node:assert/strict";
import test from "node:test";
import {runDocker} from "../docker/dockerCli.mjs";

test("runDocker captures bounded output while preserving line callbacks", async () => {
  const lines = [];
  const {stdout} = await runDocker([
    "-e",
    "process.stdout.write('alpha\\n'); process.stdout.write('bravo\\n'); process.stdout.write('x'.repeat(20));"
  ], {
    command: process.execPath,
    maxOutputChars: 12,
    onStdoutLine: (line) => lines.push(line)
  });

  assert.equal(stdout.length, 12);
  assert.deepEqual(lines, ["alpha", "bravo", "xxxxxxxxxxxxxxxxxxxx"]);
});

test("runDocker rejects and kills commands that exceed the timeout", async () => {
  await assert.rejects(
    runDocker(["-e", "setTimeout(() => {}, 1000);"], {
      command: process.execPath,
      timeoutMs: 25
    }),
    /timed out after 25ms/
  );
});

test("runDocker returns ordinary command output", async () => {
  const {stdout, stderr} = await runDocker(["-e", "process.stdout.write('ok');"], {
    command: process.execPath
  });

  assert.equal(stdout, "ok");
  assert.equal(stderr, "");
});
