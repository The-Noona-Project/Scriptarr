/**
 * @file Sage-owned durable memory helpers for public Noona Discord chat.
 */

export const NOONA_CHAT_MEMORY_KEY = "portal.noonaChat.memory";

const MAX_USER_FACTS = 12;
const MAX_SERVER_FACTS = 24;

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};
const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
const nowIso = () => new Date().toISOString();

const redactSensitiveText = (value) => normalizeString(value)
  .replace(/\b(sk|pk|xox[baprs]|gh[pousr])[-_a-z0-9]{8,}\b/gi, "[redacted credential]")
  .replace(/\b(token|secret|password|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]");

const looksSensitive = (value) => /\b(token|secret|password|api[_ -]?key|session|cookie|credential)\b/i.test(normalizeString(value));

const normalizeFact = (fact = {}) => ({
  text: redactSensitiveText(fact.text).slice(0, 280),
  createdAt: normalizeString(fact.createdAt, nowIso()),
  source: normalizeString(fact.source, "discord")
});

const normalizeUserMemory = (value = {}) => {
  const source = normalizeObject(value, {}) || {};
  return {
    discordUserId: normalizeString(source.discordUserId),
    username: normalizeString(source.username, "Reader"),
    facts: normalizeArray(source.facts)
      .map(normalizeFact)
      .filter((fact) => fact.text)
      .slice(-MAX_USER_FACTS),
    lastSeenAt: normalizeString(source.lastSeenAt),
    updatedAt: normalizeString(source.updatedAt)
  };
};

/**
 * Normalize the durable Noona memory settings payload.
 *
 * @param {unknown} value
 * @returns {{key: string, users: Record<string, unknown>, server: {facts: Array<Record<string, string>>}, updatedAt: string}}
 */
export const normalizeNoonaChatMemory = (value = {}) => {
  const source = normalizeObject(value, {}) || {};
  const users = normalizeObject(source.users, {}) || {};
  const normalizedUsers = Object.fromEntries(Object.entries(users)
    .map(([discordUserId, memory]) => [normalizeString(discordUserId), normalizeUserMemory({
      ...(normalizeObject(memory, {}) || {}),
      discordUserId
    })])
    .filter(([discordUserId]) => discordUserId));
  return {
    key: NOONA_CHAT_MEMORY_KEY,
    users: normalizedUsers,
    server: {
      facts: normalizeArray(source.server?.facts)
        .map(normalizeFact)
        .filter((fact) => fact.text)
        .slice(-MAX_SERVER_FACTS)
    },
    updatedAt: normalizeString(source.updatedAt)
  };
};

/**
 * Read the normalized Noona memory store from Vault settings.
 *
 * @param {{getSetting: Function}} vaultClient
 * @returns {Promise<ReturnType<typeof normalizeNoonaChatMemory>>}
 */
export const readNoonaChatMemory = async (vaultClient) =>
  normalizeNoonaChatMemory((await vaultClient.getSetting(NOONA_CHAT_MEMORY_KEY))?.value || {});

/**
 * Persist normalized Noona memory back to Vault settings.
 *
 * @param {{setSetting: Function}} vaultClient
 * @param {unknown} memory
 * @returns {Promise<unknown>}
 */
export const writeNoonaChatMemory = async (vaultClient, memory) =>
  vaultClient.setSetting(NOONA_CHAT_MEMORY_KEY, {
    ...normalizeNoonaChatMemory(memory),
    updatedAt: nowIso()
  });

const memoryForUser = (memory, user = {}) => {
  const discordUserId = normalizeString(user.discordUserId || user.id);
  if (!discordUserId) {
    return null;
  }
  return normalizeUserMemory({
    ...(memory.users[discordUserId] || {}),
    discordUserId,
    username: normalizeString(user.username || user.displayName || user.globalName, "Reader"),
    lastSeenAt: nowIso()
  });
};

const addUniqueFact = (facts, text, maxLength) => {
  const normalized = redactSensitiveText(text).slice(0, 280);
  if (!normalized || looksSensitive(text)) {
    return {
      facts,
      rejected: Boolean(normalized)
    };
  }
  const existing = new Set(facts.map((fact) => normalizeString(fact.text).toLowerCase()));
  if (existing.has(normalized.toLowerCase())) {
    return {facts, rejected: false, duplicate: true};
  }
  return {
    facts: [...facts, normalizeFact({text: normalized, createdAt: nowIso()})].slice(-maxLength),
    rejected: false,
    duplicate: false
  };
};

const rememberTextFromPrompt = (message) => {
  const text = normalizeString(message);
  const match = text.match(/\b(?:please\s+)?remember\s+(?:that\s+|this\s+)?(.+)$/i);
  return normalizeString(match?.[1]);
};

/**
 * Apply natural memory commands such as "remember this" or "forget me".
 *
 * @param {ReturnType<typeof normalizeNoonaChatMemory>} memory
 * @param {{message: string, user?: Record<string, unknown>}} options
 * @returns {{memory: ReturnType<typeof normalizeNoonaChatMemory>, changed: boolean, handled: boolean, reply?: string, action?: string}}
 */
export const applyNoonaMemoryCommand = (memory, {message, user = {}} = {}) => {
  const normalized = normalizeNoonaChatMemory(memory);
  const text = normalizeString(message);
  const lower = text.toLowerCase();
  const userMemory = memoryForUser(normalized, user);
  const discordUserId = normalizeString(userMemory?.discordUserId);

  if (discordUserId && /\bforget\s+me\b/i.test(text)) {
    const nextUsers = {...normalized.users};
    delete nextUsers[discordUserId];
    return {
      memory: {...normalized, users: nextUsers},
      changed: true,
      handled: true,
      action: "forget-user",
      reply: "Okay. I forgot the notes I kept about you."
    };
  }

  if (discordUserId && /\bforget\s+that\b/i.test(text)) {
    const facts = normalizeArray(userMemory?.facts).slice(0, -1);
    return {
      memory: {
        ...normalized,
        users: {
          ...normalized.users,
          [discordUserId]: {
            ...userMemory,
            facts,
            updatedAt: nowIso()
          }
        }
      },
      changed: true,
      handled: true,
      action: "forget-last",
      reply: facts.length < normalizeArray(userMemory?.facts).length
        ? "Got it. I dropped the last thing I remembered for you."
        : "I do not have a personal note to forget yet."
    };
  }

  if (discordUserId && /\bwhat\s+do\s+you\s+remember\s+about\s+me\b/i.test(lower)) {
    const facts = normalizeArray(userMemory?.facts).map((fact) => fact.text);
    return {
      memory: normalized,
      changed: false,
      handled: true,
      action: "recall-user",
      reply: facts.length
        ? `I remember: ${facts.join("; ")}.`
        : "I do not have any personal notes about you yet."
    };
  }

  const remembered = rememberTextFromPrompt(text);
  if (discordUserId && remembered) {
    const result = addUniqueFact(normalizeArray(userMemory?.facts), remembered, MAX_USER_FACTS);
    return {
      memory: {
        ...normalized,
        users: {
          ...normalized.users,
          [discordUserId]: {
            ...userMemory,
            facts: result.facts,
            updatedAt: nowIso()
          }
        }
      },
      changed: true,
      handled: true,
      action: result.rejected ? "remember-rejected" : "remember-user",
      reply: result.rejected
        ? "I will not remember secrets or credentials. That stays out of Noona memory."
        : result.duplicate
          ? "I already had that tucked away."
          : "I will remember that."
    };
  }

  if (/long\s+live\s+noona/i.test(text)) {
    const result = addUniqueFact(normalizeArray(normalized.server?.facts), "The server likes saying LONG LIVE NOONA.", MAX_SERVER_FACTS);
    return {
      memory: {
        ...normalized,
        server: {
          facts: result.facts
        }
      },
      changed: !result.duplicate && !result.rejected,
      handled: false,
      action: "server-lore"
    };
  }

  if (discordUserId && userMemory) {
    return {
      memory: {
        ...normalized,
        users: {
          ...normalized.users,
          [discordUserId]: userMemory
        }
      },
      changed: true,
      handled: false,
      action: "touch-user"
    };
  }

  return {
    memory: normalized,
    changed: false,
    handled: false
  };
};

/**
 * Build a compact memory summary suitable for Oracle prompt context.
 *
 * @param {ReturnType<typeof normalizeNoonaChatMemory>} memory
 * @param {string} discordUserId
 * @returns {{userFacts: string[], serverFacts: string[], counts: {users: number, userFacts: number, serverFacts: number}}}
 */
export const buildNoonaMemoryContext = (memory, discordUserId = "") => {
  const normalized = normalizeNoonaChatMemory(memory);
  const userMemory = normalized.users[normalizeString(discordUserId)] || {};
  const userFacts = normalizeArray(userMemory.facts).map((fact) => fact.text).filter(Boolean);
  const serverFacts = normalizeArray(normalized.server?.facts).map((fact) => fact.text).filter(Boolean);
  return {
    userFacts,
    serverFacts,
    counts: {
      users: Object.keys(normalized.users).length,
      userFacts: userFacts.length,
      serverFacts: serverFacts.length
    }
  };
};

/**
 * Build an admin-safe memory summary for the Discord settings page.
 *
 * @param {{getSetting: Function}} vaultClient
 * @returns {Promise<Record<string, unknown>>}
 */
export const buildNoonaMemoryAdminPayload = async (vaultClient) => {
  const memory = await readNoonaChatMemory(vaultClient);
  const users = Object.values(memory.users).map((user) => ({
    discordUserId: user.discordUserId,
    username: user.username,
    factCount: normalizeArray(user.facts).length,
    facts: normalizeArray(user.facts).map((fact) => fact.text),
    updatedAt: user.updatedAt || user.lastSeenAt || ""
  }));
  return {
    key: NOONA_CHAT_MEMORY_KEY,
    users,
    userCount: users.length,
    userFactCount: users.reduce((sum, user) => sum + user.factCount, 0),
    serverFactCount: normalizeArray(memory.server?.facts).length,
    serverFacts: normalizeArray(memory.server?.facts).map((fact) => fact.text),
    updatedAt: memory.updatedAt || ""
  };
};

/**
 * Clear all or part of the durable Noona memory payload.
 *
 * @param {{getSetting: Function, setSetting: Function}} vaultClient
 * @param {{scope?: string, discordUserId?: string}} options
 * @returns {Promise<ReturnType<typeof normalizeNoonaChatMemory>>}
 */
export const clearNoonaMemory = async (vaultClient, {scope = "all", discordUserId = ""} = {}) => {
  const memory = await readNoonaChatMemory(vaultClient);
  const normalizedScope = normalizeString(scope, "all").toLowerCase();
  let next = memory;
  if (normalizedScope === "user" && normalizeString(discordUserId)) {
    const users = {...memory.users};
    delete users[normalizeString(discordUserId)];
    next = {...memory, users};
  } else if (normalizedScope === "server") {
    next = {...memory, server: {facts: []}};
  } else {
    next = normalizeNoonaChatMemory({});
  }
  await writeNoonaChatMemory(vaultClient, next);
  return readNoonaChatMemory(vaultClient);
};

export default {
  NOONA_CHAT_MEMORY_KEY,
  applyNoonaMemoryCommand,
  buildNoonaMemoryAdminPayload,
  buildNoonaMemoryContext,
  clearNoonaMemory,
  normalizeNoonaChatMemory,
  readNoonaChatMemory,
  writeNoonaChatMemory
};
