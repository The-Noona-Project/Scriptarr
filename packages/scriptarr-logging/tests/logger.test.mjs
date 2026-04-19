import test from "node:test";
import assert from "node:assert/strict";

import {createLogger, sanitizeStructuredData} from "../index.mjs";

const createSink = () => {
  const lines = [];

  return {
    lines,
    log: (line) => {
      lines.push(line);
    },
    warn: (line) => {
      lines.push(line);
    },
    error: (line) => {
      lines.push(line);
    }
  };
};

test("logger colorizes output by default", async () => {
  const sink = createSink();
  const logger = createLogger("WARDEN", {
    env: {
      SCRIPTARR_LOG_LEVEL: "debug"
    },
    sink
  });

  logger.info("Booting services.", {container: "scriptarr-warden"});
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(sink.lines[0], /\u001b\[/);
  assert.match(sink.lines[0], /Booting services\./);
});

test("logger honors NO_COLOR and redacts sensitive fields", async () => {
  const sink = createSink();
  const logger = createLogger("ORACLE", {
    env: {
      NO_COLOR: "1"
    },
    sink
  });

  logger.error("Provider failed.", {
    apiKey: "secret-value",
    token: "abc123",
    reason: "timeout"
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.doesNotMatch(sink.lines[0], /\u001b\[/);
  assert.match(sink.lines[0], /apiKey=\[redacted\]/);
  assert.match(sink.lines[0], /token=\[redacted\]/);
  assert.match(sink.lines[0], /reason=timeout/);
});

test("sanitizeStructuredData redacts nested secrets while preserving shape", () => {
  const payload = sanitizeStructuredData({
    serviceTokens: {
      "scriptarr-sage": "sage-token"
    },
    discordTokenConfigured: true,
    openAiApiKeyConfigured: false,
    services: [{
      env: {
        DISCORD_TOKEN: "bot-token",
        SUPERUSER_ID: "owner-1"
      }
    }]
  });

  assert.equal(payload.serviceTokens, "[redacted]");
  assert.equal(payload.discordTokenConfigured, true);
  assert.equal(payload.openAiApiKeyConfigured, false);
  assert.equal(payload.services[0].env.DISCORD_TOKEN, "[redacted]");
  assert.equal(payload.services[0].env.SUPERUSER_ID, "owner-1");
});
