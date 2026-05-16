import test from "node:test";
import assert from "node:assert/strict";
import {
  buildToolPayload,
  getProposal,
  markToolUsed,
  proposeAiAction,
  updateProposalStatus,
  writeAiToolSettings
} from "../lib/aiTools.mjs";

const createMemoryVault = () => {
  const settings = new Map();
  return {
    async getSetting(key) {
      return settings.has(key) ? {key, value: settings.get(key)} : null;
    },
    async setSetting(key, value) {
      settings.set(key, value);
      return {key, value};
    }
  };
};

test("AI tool payload defaults read tools on and operation tools off", async () => {
  const vault = createMemoryVault();
  const payload = await buildToolPayload(vault);
  assert.equal(payload.tools.find((tool) => tool.id === "stack_status").enabled, true);
  assert.equal(payload.tools.find((tool) => tool.id === "trivia_start").enabled, false);

  await markToolUsed(vault, "stack_status");
  const updated = await buildToolPayload(vault);
  assert.ok(updated.tools.find((tool) => tool.id === "stack_status").lastUsedAt);
});

test("AI operation prompts create confirmable proposals only when enabled", async () => {
  const vault = createMemoryVault();
  const disabled = await proposeAiAction({
    vaultClient: vault,
    prompt: "start trivia",
    user: {username: "Admin"}
  });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.status, 409);

  await writeAiToolSettings(vault, {
    toggles: {
      trivia_start: true
    }
  });
  const proposed = await proposeAiAction({
    vaultClient: vault,
    prompt: "start trivia",
    user: {username: "Admin"}
  });
  assert.equal(proposed.ok, true);
  assert.equal(proposed.mode, "proposal");

  const stored = await getProposal(vault, proposed.proposal.id);
  assert.equal(stored.toolId, "trivia_start");
  const cancelled = await updateProposalStatus(vault, stored.id, "cancelled", {result: {ok: true}});
  assert.equal(cancelled.status, "cancelled");
});

test("AI operation proposals can be restricted to a surface allowlist", async () => {
  const vault = createMemoryVault();
  await writeAiToolSettings(vault, {
    toggles: {
      trivia_start: true,
      localai_install: true
    }
  });

  const blocked = await proposeAiAction({
    vaultClient: vault,
    prompt: "run localai install",
    user: {username: "Noona"},
    allowedToolIds: ["trivia_start", "trivia_stop"]
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 403);

  const allowed = await proposeAiAction({
    vaultClient: vault,
    prompt: "start trivia",
    user: {username: "Noona"},
    allowedToolIds: ["trivia_start", "trivia_stop"]
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.proposal.toolId, "trivia_start");
});
