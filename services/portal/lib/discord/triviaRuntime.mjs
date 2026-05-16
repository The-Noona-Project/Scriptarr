import {normalizeString, truncate} from "./utils.mjs";

const CHECK_REACTION = "\u2705";
const WRONG_REACTION = "\u274C";
const EYES_REACTION = "\u{1F440}";
const ACTIVE_ROUND_CACHE_MS = 3000;
const IN_FLIGHT_MESSAGE_TTL_MS = 60000;
const TRIVIA_STATE_TIMEOUT_MS = 2500;
const TRIVIA_GUESS_TIMEOUT_MS = 9000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const DEFAULT_TRIVIA_COOLDOWN_MINUTES = 30;

const normalizeArray = (value) => Array.isArray(value) ? value : [];

const minutesToMs = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Math.max(1, Number.isFinite(parsed) ? parsed : fallback) * 60 * 1000;
};

const normalizeObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;

const parseDateMs = (value) => {
  const parsed = Date.parse(normalizeString(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const delayUntil = (value, fallbackMs = 1000) => {
  const parsed = parseDateMs(value);
  if (!parsed) {
    return fallbackMs;
  }
  return Math.max(1000, parsed - Date.now());
};

const roundHintDelayMs = (round = {}, hintMinute) => {
  const startedAt = parseDateMs(round.startedAt);
  if (!startedAt) {
    return minutesToMs(hintMinute, 7);
  }
  return Math.max(1000, (startedAt + minutesToMs(hintMinute, 7)) - Date.now());
};

const withTimeout = (promise, timeoutMs, label) => {
  let timeout = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)), timeoutMs);
    })
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
};

const nextScheduledAt = (kind, hour = 20) => {
  const now = new Date();
  const next = new Date(now);
  next.setHours(Math.max(0, Math.min(23, Number.parseInt(String(hour), 10) || 20)), 0, 0, 0);
  if (kind === "weekly") {
    const daysUntilSunday = (7 - next.getDay()) % 7;
    next.setDate(next.getDate() + daysUntilSunday);
  } else if (kind === "monthly") {
    next.setDate(1);
    if (next <= now) {
      next.setMonth(next.getMonth() + 1);
    }
  }
  if (next <= now) {
    next.setDate(next.getDate() + (kind === "weekly" ? 7 : 1));
  }
  return next;
};

const resolveUserName = (message) =>
  normalizeString(
    message?.member?.displayName
    || message?.author?.globalName
    || message?.author?.username,
    "reader"
  );

const renderRoundPrompt = (round = {}) => [
  "**Noona Trivia**",
  "Guess the title from this sanitized summary. Aliases, title links, and tiny spelling mistakes count.",
  "",
  truncate(round.prompt || round.clue || "No clue is available for this round.", 1400)
].join("\n");

const renderHint = (round = {}, hint = {}) => [
  "**Noona Trivia Hint**",
  normalizeString(hint.text, "No extra hint is available yet."),
  round.readerUrl ? `Read link after reveal: ${round.readerUrl}` : ""
].filter(Boolean).join("\n");

const renderWin = (result = {}) => {
  const round = result.round || {};
  const guess = result.guess || {};
  const score = result.scoreEvent || {};
  return [
    `Correct, <@${guess.discordUserId}>!`,
    `Answer: **${round.title}**`,
    `XP earned: ${Number(score.xp || 0)}`,
    round.readerUrl ? `Read: ${round.readerUrl}` : ""
  ].filter(Boolean).join("\n");
};

const renderTimeout = (result = {}) => {
  const round = result.round || {};
  return [
    "Trivia round timed out.",
    `Answer: **${round.title || "Unknown"}**`,
    round.readerUrl ? `Read: ${round.readerUrl}` : ""
  ].filter(Boolean).join("\n");
};

export const renderLeaderboard = (leaderboard = {}) => {
  const rows = normalizeArray(leaderboard.rows);
  const title = normalizeString(leaderboard.window, "all");
  if (!rows.length) {
    return `Noona Trivia leaderboard (${title}): no scores yet.`;
  }
  const lines = rows.slice(0, 10).map((row, index) =>
    `${index + 1}. ${normalizeString(row.username, row.discordUserId)} - ${Number(row.xp || 0)} XP (${Number(row.wins || 0)} wins)`
  );
  return [`Noona Trivia leaderboard (${title})`, ...lines].join("\n");
};

export const createTriviaRuntime = ({
  sage,
  discord,
  getSettings,
  logger,
  onRuntimeEvent
}) => {
  let timers = [];
  let stopped = false;
  let scheduleGeneration = 0;
  let activeRoundCache = {round: null, expiresAt: 0};
  const inFlightMessages = new Map();

  const clearTimers = () => {
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers = [];
    scheduleGeneration += 1;
  };

  const clearActiveRoundCache = () => {
    activeRoundCache = {round: null, expiresAt: 0};
  };

  const rememberActiveRound = (round = null) => {
    activeRoundCache = {
      round: round?.id ? round : null,
      expiresAt: Date.now() + ACTIVE_ROUND_CACHE_MS
    };
  };

  const resolveActiveRound = async () => {
    if (activeRoundCache.round?.id && activeRoundCache.expiresAt > Date.now()) {
      return activeRoundCache.round;
    }
    const startedAt = Date.now();
    const state = await withTimeout(
      sage.getTriviaState(),
      TRIVIA_STATE_TIMEOUT_MS,
      "Trivia state"
    );
    const round = state.ok ? state.payload?.activeRound : null;
    rememberActiveRound(round);
    logger?.info?.("Trivia active round state loaded.", {
      roundId: round?.id || "",
      latencyMs: Date.now() - startedAt
    });
    return round?.id ? round : null;
  };

  const pruneInFlightMessages = () => {
    const now = Date.now();
    for (const [messageId, expiresAt] of inFlightMessages.entries()) {
      if (expiresAt <= now) {
        inFlightMessages.delete(messageId);
      }
    }
  };

  const reserveMessage = (messageId) => {
    const normalized = normalizeString(messageId);
    if (!normalized) {
      return true;
    }
    pruneInFlightMessages();
    if (inFlightMessages.has(normalized)) {
      return false;
    }
    inFlightMessages.set(normalized, Date.now() + IN_FLIGHT_MESSAGE_TTL_MS);
    return true;
  };

  const releaseMessage = (messageId) => {
    const normalized = normalizeString(messageId);
    if (normalized) {
      inFlightMessages.delete(normalized);
    }
  };

  const reactSafely = async (message, reaction, label) => {
    try {
      await message.react?.(reaction);
      logger?.info?.("Trivia reaction sent.", {
        messageId: normalizeString(message?.id),
        reaction: label
      });
      return true;
    } catch (error) {
      logger?.warn?.("Trivia reaction failed.", {
        messageId: normalizeString(message?.id),
        reaction: label,
        error
      });
      return false;
    }
  };

  const currentSettings = () => getSettings?.()?.trivia || {};
  const actionSettings = (override = null) => {
    const base = currentSettings();
    const source = normalizeObject(override?.trivia) || normalizeObject(override) || null;
    if (!source) {
      return base;
    }
    return {
      ...base,
      ...source,
      leaderboardSchedules: {
        ...(base.leaderboardSchedules || {}),
        ...(source.leaderboardSchedules || {})
      }
    };
  };
  const triviaEnabled = (settingsOverride = null) => {
    const settings = settingsOverride || currentSettings();
    return Boolean(settings.enabled && settings.channelId);
  };

  const isCurrentGeneration = (generation) => !stopped && generation === scheduleGeneration;

  const schedule = (callback, delayMs, generation = scheduleGeneration) => {
    const dueAt = Date.now() + Math.max(1000, Number(delayMs) || 0);
    let timer = null;
    const arm = (ms) => {
      timer = setTimeout(() => {
        timers = timers.filter((entry) => entry !== timer);
        if (!isCurrentGeneration(generation)) {
          return;
        }
        const remaining = dueAt - Date.now();
        if (remaining > 1000) {
          arm(Math.min(remaining, MAX_TIMER_DELAY_MS));
          return;
        }
        void callback(generation);
      }, Math.min(Math.max(1000, ms), MAX_TIMER_DELAY_MS));
      timers.push(timer);
    };
    arm(Math.min(Math.max(1000, Number(delayMs) || 0), MAX_TIMER_DELAY_MS));
    return timer;
  };

  const postLeaderboard = async (windowName = "all", channelId = "", options = {}) => {
    const startedAt = Date.now();
    const settings = options.settings || currentSettings();
    const targetChannelId = normalizeString(channelId || settings.leaderboardChannelId || settings.channelId);
    if (!targetChannelId) {
      throw new Error("A trivia leaderboard channel id is required.");
    }
    const leaderboard = await sage.getTriviaLeaderboard(windowName, 10);
    if (!leaderboard.ok) {
      throw new Error(leaderboard.payload?.error || "Noona could not load trivia leaderboard data.");
    }
    const message = await withTimeout(
      discord.sendChannelMessage(targetChannelId, {content: renderLeaderboard(leaderboard.payload)}),
      10000,
      "Discord trivia leaderboard send"
    );
    const postId = `trivia-leaderboard:${windowName}:${message?.id || Date.now()}`;
    await sage.acknowledgeTriviaLeaderboard(postId).catch((error) => {
      logger?.warn?.("Trivia leaderboard acknowledgement failed.", {error, postId});
    });
    logger?.info?.("Trivia leaderboard posted.", {
      windowName,
      channelId: targetChannelId,
      latencyMs: Date.now() - startedAt
    });
    return {channelId: targetChannelId, leaderboard: leaderboard.payload, postId};
  };

  const scheduleRoundFollowups = (round = {}, settingsOverride = null, generation = scheduleGeneration) => {
    const settings = settingsOverride || currentSettings();
    if (!triviaEnabled(settings) || !round?.id) {
      return;
    }
    const postedHints = new Set(normalizeArray(round.hintsPosted).map((entry) => Number.parseInt(String(entry), 10)).filter(Number.isFinite));
    if (settings.hintsEnabled !== false) {
      for (const hintMinute of normalizeArray(settings.hintMinutes)) {
        const normalizedMinute = Number.parseInt(String(hintMinute), 10);
        if (!Number.isFinite(normalizedMinute) || postedHints.has(normalizedMinute)) {
          continue;
        }
        schedule(async (scheduledGeneration) => {
          if (!isCurrentGeneration(scheduledGeneration)) {
            return;
          }
          const result = await sage.postTriviaHint(round.id, hintMinute);
          if (!isCurrentGeneration(scheduledGeneration)) {
            return;
          }
          if (result.ok && result.payload?.hint?.postedAt) {
            await discord.sendChannelMessage(settings.channelId, {
              content: renderHint(result.payload.round, result.payload.hint)
            });
          }
        }, roundHintDelayMs(round, hintMinute), generation);
      }
    }
    schedule(async (scheduledGeneration) => {
      if (!isCurrentGeneration(scheduledGeneration)) {
        return;
      }
      const result = await sage.timeoutTriviaRound(round.id);
      if (!isCurrentGeneration(scheduledGeneration)) {
        return;
      }
      if (result.ok && result.payload?.ok !== false) {
        clearActiveRoundCache();
        await discord.sendChannelMessage(settings.channelId, {
          content: renderTimeout(result.payload)
        });
        if (settings.leaderboardAfterRound !== false) {
          await postLeaderboard("all").catch((error) => {
            logger?.warn?.("Trivia leaderboard post after timeout failed.", {error});
          });
        }
        await reconcileTriviaClock(settings);
      }
    }, round.expiresAt ? delayUntil(round.expiresAt, minutesToMs(settings.roundDurationMinutes, 20)) : minutesToMs(settings.roundDurationMinutes, 20), generation);
  };

  const scheduleLeaderboardPosts = (settingsOverride = null, generation = scheduleGeneration) => {
    const settings = settingsOverride || currentSettings();
    if (!triviaEnabled(settings)) {
      return;
    }
    const schedules = settings.leaderboardSchedules || {};
    const scheduleWindow = (windowName) => {
      if (schedules[windowName] === false) {
        return;
      }
      const at = nextScheduledAt(windowName, schedules.hour);
      schedule(async (scheduledGeneration) => {
        if (!isCurrentGeneration(scheduledGeneration)) {
          return;
        }
        await postLeaderboard(windowName).catch((error) => {
          logger?.warn?.("Scheduled trivia leaderboard post failed.", {windowName, error});
        });
        if (isCurrentGeneration(scheduledGeneration)) {
          scheduleWindow(windowName);
        }
      }, at.getTime() - Date.now(), generation);
    };
    for (const windowName of ["daily", "weekly", "monthly"]) {
      scheduleWindow(windowName);
    }
  };

  const startRoundNow = async ({requestedBy = "scriptarr-portal", force = false, settings: settingsOverride = null} = {}) => {
    const settings = actionSettings(settingsOverride);
    if (!settings.enabled || !settings.channelId) {
      throw new Error("Trivia is disabled or missing a trivia channel id.");
    }
    const result = await sage.startTriviaRound({requestedBy, force});
    if (!result.ok || result.payload?.ok === false) {
      throw new Error(result.payload?.error || "Noona could not start a trivia round.");
    }
    if (result.payload?.reused) {
      rememberActiveRound(result.payload.round);
      await reconcileTriviaClock(settings);
      return result.payload;
    }
    clearTimers();
    const generation = scheduleGeneration;
    await withTimeout(
      discord.sendChannelMessage(settings.channelId, {content: renderRoundPrompt(result.payload.round)}),
      10000,
      "Discord trivia round send"
    );
    rememberActiveRound(result.payload.round);
    scheduleLeaderboardPosts(settings, generation);
    scheduleRoundFollowups(result.payload.round, settings, generation);
    onRuntimeEvent?.({
      type: "trivia-round-started",
      at: new Date().toISOString(),
      roundId: result.payload.round?.id
    });
    return result.payload;
  };

  const stopRound = async ({requestedBy = "scriptarr-portal"} = {}) => {
    const result = await sage.stopTriviaRound({requestedBy});
    if (!result.ok || result.payload?.ok === false) {
      throw new Error(result.payload?.error || "Noona could not stop the active trivia round.");
    }
    clearTimers();
    clearActiveRoundCache();
    if (result.payload?.stopped && currentSettings().channelId) {
      const answer = normalizeString(result.payload.answer || result.payload.round?.title, "unknown");
      await discord.sendChannelMessage(currentSettings().channelId, {
        content: `Trivia stopped. Answer was **${answer}**.`
      }).catch((error) => logger?.warn?.("Trivia stop message failed.", {error}));
    }
    return result.payload;
  };

  const loadTriviaState = async () => {
    const result = await withTimeout(
      sage.getTriviaState(),
      TRIVIA_STATE_TIMEOUT_MS,
      "Trivia state"
    );
    return result.ok ? result.payload || {} : {};
  };

  const scheduleNextRound = (settingsOverride = null, state = {}, generation = scheduleGeneration) => {
    const settings = settingsOverride || currentSettings();
    if (!isCurrentGeneration(generation) || !triviaEnabled(settings)) {
      return;
    }
    const delayMs = normalizeString(state.nextRoundAfter)
      ? delayUntil(state.nextRoundAfter, minutesToMs(settings.cooldownMinMinutes, DEFAULT_TRIVIA_COOLDOWN_MINUTES))
      : minutesToMs(settings.cooldownMinMinutes, DEFAULT_TRIVIA_COOLDOWN_MINUTES);
    schedule(async (scheduledGeneration) => {
      if (!isCurrentGeneration(scheduledGeneration) || !triviaEnabled(settings)) {
        return;
      }
      try {
        await startRoundNow({requestedBy: "scriptarr-portal", force: false, settings});
      } catch (error) {
        logger?.warn?.("Scheduled trivia round did not start.", {error});
        if (isCurrentGeneration(scheduledGeneration)) {
          await reconcileTriviaClock(settings);
        }
      }
    }, delayMs, generation);
  };

  const reconcileTriviaClock = async (settingsOverride = null) => {
    const settings = actionSettings(settingsOverride);
    clearTimers();
    clearActiveRoundCache();
    const generation = scheduleGeneration;
    if (stopped || !triviaEnabled(settings)) {
      return;
    }
    let state = {};
    try {
      state = await loadTriviaState();
    } catch (error) {
      logger?.warn?.("Trivia clock reconciliation failed.", {error});
    }
    if (!isCurrentGeneration(generation)) {
      return;
    }
    scheduleLeaderboardPosts(settings, generation);
    if (state.activeRound?.id) {
      rememberActiveRound(state.activeRound);
      scheduleRoundFollowups(state.activeRound, settings, generation);
      return;
    }
    rememberActiveRound(null);
    scheduleNextRound(settings, state, generation);
  };

  const handleGuildMessage = async (message) => {
    const settings = currentSettings();
    if (!settings.enabled || !settings.channelId) {
      return;
    }
    if (normalizeString(message?.channelId) !== normalizeString(settings.channelId)) {
      return;
    }
    if (message?.author?.bot) {
      return;
    }
    if (!reserveMessage(message?.id)) {
      logger?.info?.("Duplicate trivia message ignored.", {messageId: normalizeString(message?.id)});
      return;
    }
    try {
      const round = await resolveActiveRound();
      if (!round?.id) {
        releaseMessage(message?.id);
        return;
      }
      logger?.info?.("Trivia guess accepted for judging.", {
        messageId: normalizeString(message?.id),
        roundId: round.id,
        authorId: normalizeString(message?.author?.id)
      });
      await reactSafely(message, EYES_REACTION, "eyes");
      const startedAt = Date.now();
      const guess = await withTimeout(
        sage.submitTriviaGuess(round.id, {
          discordUserId: message?.author?.id,
          username: resolveUserName(message),
          content: message?.content,
          messageId: message?.id
        }),
        TRIVIA_GUESS_TIMEOUT_MS,
        "Trivia guess"
      );
      logger?.info?.("Trivia guess judged.", {
        messageId: normalizeString(message?.id),
        roundId: round.id,
        correct: guess.payload?.correct === true,
        close: guess.payload?.close === true,
        duplicate: guess.payload?.duplicate === true,
        matchedBy: normalizeString(guess.payload?.guess?.matchedBy),
        latencyMs: Date.now() - startedAt
      });
      if (!guess.ok || guess.payload?.ok === false || guess.payload?.ignored) {
        releaseMessage(message?.id);
        return;
      }
      if (guess.payload.correct) {
        await reactSafely(message, CHECK_REACTION, "correct");
        await discord.sendChannelMessage(settings.channelId, {
          content: renderWin(guess.payload)
        });
        clearTimers();
        clearActiveRoundCache();
        if (settings.leaderboardAfterRound !== false) {
          await postLeaderboard("all").catch((error) => {
            logger?.warn?.("Trivia leaderboard post after win failed.", {error});
          });
        }
        await scheduleAll();
        return;
      }
      await reactSafely(message, WRONG_REACTION, "wrong");
    } catch (error) {
      logger?.warn?.("Trivia guess handling failed.", {
        messageId: normalizeString(message?.id),
        error
      });
      releaseMessage(message?.id);
    }
  };

  const start = async () => {
    stopped = false;
    await reconcileTriviaClock();
  };

  const stop = () => {
    stopped = true;
    clearTimers();
    clearActiveRoundCache();
  };

  const refreshSettings = async () => {
    if (!stopped) {
      await reconcileTriviaClock();
    }
  };

  const scheduleAll = async () => {
    await reconcileTriviaClock();
  };

  return {
    start,
    stop,
    refreshSettings,
    handleGuildMessage,
    startRoundNow,
    stopRound,
    postLeaderboard
  };
};

export default createTriviaRuntime;
