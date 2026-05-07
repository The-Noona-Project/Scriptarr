/**
 * @file Durable Discord trivia helpers owned by Sage.
 */

const TRIVIA_STATE_KEY = "portal.trivia.state";
const MAX_ROUNDS = 120;
const MAX_GUESSES = 1200;
const MAX_SCORE_EVENTS = 5000;
const MAX_ACKS = 500;
const ORACLE_MATCH_TIMEOUT_MS = 5000;

const normalizeString = (value, fallback = "") => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || fallback;
};

const normalizeArray = (value) => Array.isArray(value) ? value : [];
const normalizeObject = (value, fallback = null) => value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
const normalizeInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

const parseDateMs = (value) => {
  const parsed = Date.parse(normalizeString(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const nowIso = () => new Date().toISOString();

const slug = (value) => normalizeString(value)
  .toLowerCase()
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/https?:\/\/\S+/g, " ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .replace(/\s+/g, " ");

const normalizeGuessText = (value) => {
  const withoutMentions = normalizeString(value)
    .replace(/<@!?\d+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const withoutTrailingPunctuation = withoutMentions
    .replace(/^[\s:,-]+/, "")
    .replace(/[\s?!.,;:]+$/g, "")
    .trim();
  const jeopardyMatch = withoutTrailingPunctuation.match(/^(?:what|who)\s+(?:is|are)\s+(.+)$/i);
  const answer = jeopardyMatch ? jeopardyMatch[1] : withoutTrailingPunctuation;
  return answer
    .replace(/^[\s:,-]+/, "")
    .replace(/[\s?!.,;:]+$/g, "")
    .trim();
};

const escapeRegExp = (value) => normalizeString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeTypeSlug = (value, fallback = "manga") => {
  const normalized = normalizeString(value, fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return normalized || fallback;
};

const defaultState = () => ({
  activeRoundId: "",
  nextRoundAfter: "",
  rounds: [],
  guesses: [],
  scoreEvents: [],
  leaderboardAcks: []
});

const normalizeRound = (round = {}) => ({
  id: normalizeString(round.id),
  titleId: normalizeString(round.titleId),
  title: normalizeString(round.title, "Untitled"),
  aliases: normalizeArray(round.aliases).map((entry) => normalizeString(entry)).filter(Boolean),
  sourceUrl: normalizeString(round.sourceUrl),
  moonTitleUrl: normalizeString(round.moonTitleUrl),
  libraryTypeSlug: normalizeTypeSlug(round.libraryTypeSlug || round.mediaType),
  summary: normalizeString(round.summary),
  prompt: normalizeString(round.prompt),
  status: ["open", "won", "timeout", "cancelled"].includes(normalizeString(round.status)) ? normalizeString(round.status) : "open",
  startedAt: normalizeString(round.startedAt, nowIso()),
  expiresAt: normalizeString(round.expiresAt),
  endedAt: normalizeString(round.endedAt),
  winnerDiscordUserId: normalizeString(round.winnerDiscordUserId),
  winnerUsername: normalizeString(round.winnerUsername),
  acceptedAnswer: normalizeString(round.acceptedAnswer),
  hintsPosted: normalizeArray(round.hintsPosted).map((entry) => normalizeInteger(entry, 0)).filter((entry) => entry > 0),
  createdBy: normalizeString(round.createdBy, "scriptarr")
});

const normalizeGuess = (guess = {}) => ({
  id: normalizeString(guess.id),
  roundId: normalizeString(guess.roundId),
  discordUserId: normalizeString(guess.discordUserId),
  username: normalizeString(guess.username, "Discord user"),
  content: normalizeString(guess.content).slice(0, 500),
  normalized: normalizeString(guess.normalized),
  correct: guess.correct === true,
  close: guess.close === true,
  matchedBy: normalizeString(guess.matchedBy),
  aiNote: normalizeString(guess.aiNote),
  createdAt: normalizeString(guess.createdAt, nowIso())
});

const normalizeScoreEvent = (event = {}) => ({
  id: normalizeString(event.id),
  roundId: normalizeString(event.roundId),
  discordUserId: normalizeString(event.discordUserId),
  username: normalizeString(event.username, "Discord user"),
  xp: normalizeInteger(event.xp, 0),
  baseXp: normalizeInteger(event.baseXp, 0),
  speedBonus: normalizeInteger(event.speedBonus, 0),
  streakBonus: normalizeInteger(event.streakBonus, 0),
  streak: normalizeInteger(event.streak, 1),
  createdAt: normalizeString(event.createdAt, nowIso())
});

const normalizeState = (value = {}) => {
  const state = normalizeObject(value, {}) || {};
  return {
    activeRoundId: normalizeString(state.activeRoundId),
    nextRoundAfter: normalizeString(state.nextRoundAfter),
    rounds: normalizeArray(state.rounds).map(normalizeRound).filter((round) => round.id).slice(-MAX_ROUNDS),
    guesses: normalizeArray(state.guesses).map(normalizeGuess).filter((guess) => guess.id).slice(-MAX_GUESSES),
    scoreEvents: normalizeArray(state.scoreEvents).map(normalizeScoreEvent).filter((event) => event.id).slice(-MAX_SCORE_EVENTS),
    leaderboardAcks: normalizeArray(state.leaderboardAcks).map((entry) => normalizeString(entry)).filter(Boolean).slice(-MAX_ACKS)
  };
};

const readState = async (vaultClient) =>
  normalizeState((await vaultClient.getSetting(TRIVIA_STATE_KEY))?.value || defaultState());

const writeState = async (vaultClient, state) =>
  vaultClient.setSetting(TRIVIA_STATE_KEY, normalizeState(state));

const activeRoundFromState = (state) => {
  const active = normalizeString(state.activeRoundId)
    ? state.rounds.find((round) => round.id === state.activeRoundId)
    : null;
  if (!active || active.status !== "open") {
    return null;
  }
  if (parseDateMs(active.expiresAt) && Date.now() >= parseDateMs(active.expiresAt)) {
    return null;
  }
  return active;
};

const titleTerms = (title = {}) => [
  normalizeString(title.title),
  ...normalizeArray(title.aliases).map((entry) => normalizeString(entry))
].filter((entry) => entry.length >= 3);

const sanitizeSummary = (title = {}) => {
  let summary = normalizeString(title.summary).replace(/\s+/g, " ");
  for (const term of titleTerms(title).sort((left, right) => right.length - left.length)) {
    summary = summary.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, "gi"), "____");
  }
  return summary.trim();
};

const isLikelyAdultTitle = (title = {}) => {
  const text = [
    normalizeString(title.nsfw),
    normalizeString(title.adultContent),
    normalizeString(title.mature),
    ...normalizeArray(title.tags)
  ].join(" ").toLowerCase();
  return /\b(nsfw|adult|hentai|smut|erotica|18\+)\b/.test(text);
};

const toTriviaTitle = (config, title = {}) => {
  const typeSlug = normalizeTypeSlug(title.libraryTypeSlug || title.mediaType);
  const titleId = normalizeString(title.id);
  return {
    titleId,
    title: normalizeString(title.title, "Untitled"),
    aliases: normalizeArray(title.aliases).map((entry) => normalizeString(entry)).filter(Boolean),
    sourceUrl: normalizeString(title.sourceUrl),
    moonTitleUrl: titleId && config.publicBaseUrl
      ? `${normalizeString(config.publicBaseUrl).replace(/\/+$/, "")}/title/${encodeURIComponent(typeSlug)}/${encodeURIComponent(titleId)}`
      : "",
    libraryTypeSlug: typeSlug,
    summary: normalizeString(title.summary),
    prompt: sanitizeSummary(title)
  };
};

const eligibleTriviaTitles = (config, titles = []) => normalizeArray(titles)
  .filter((title) => normalizeString(title.id) && normalizeString(title.title))
  .filter((title) => !isLikelyAdultTitle(title))
  .map((title) => toTriviaTitle(config, title))
  .filter((title) => title.prompt.length >= 80 && slug(title.prompt).split(" ").length >= 12);

const pickTitle = (titles, state) => {
  const recentIds = new Set([...state.rounds].slice(-20).map((round) => round.titleId));
  const fresh = titles.filter((title) => !recentIds.has(title.titleId));
  const pool = fresh.length ? fresh : titles;
  return pool[Math.floor(Math.random() * pool.length)] || null;
};

const roundPublicPayload = (round = {}) => {
  const source = normalizeObject(round, {}) || {};
  if (!normalizeString(source.id)) {
    return null;
  }
  return {
    id: normalizeString(source.id),
    status: normalizeString(source.status),
    titleId: normalizeString(source.titleId),
    title: source.status === "open" ? "" : normalizeString(source.title),
    prompt: normalizeString(source.prompt),
    libraryTypeSlug: normalizeString(source.libraryTypeSlug),
    moonTitleUrl: source.status === "open" ? "" : normalizeString(source.moonTitleUrl),
    startedAt: normalizeString(source.startedAt),
    expiresAt: normalizeString(source.expiresAt),
    endedAt: normalizeString(source.endedAt),
    winnerDiscordUserId: normalizeString(source.winnerDiscordUserId),
    winnerUsername: normalizeString(source.winnerUsername),
    hintsPosted: normalizeArray(source.hintsPosted)
  };
};

const roundAdminPayload = (round = {}, {includeActiveAnswer = false} = {}) => {
  const source = normalizeObject(round, {}) || {};
  const base = roundPublicPayload(source);
  if (!base) {
    return null;
  }
  const canShowAnswer = source.status !== "open" || includeActiveAnswer;
  return {
    ...base,
    title: canShowAnswer ? normalizeString(source.title) : "",
    answer: canShowAnswer ? normalizeString(source.title) : "",
    aliases: canShowAnswer ? normalizeArray(source.aliases).map((entry) => normalizeString(entry)).filter(Boolean) : [],
    sourceUrl: canShowAnswer ? normalizeString(source.sourceUrl) : "",
    moonTitleUrl: canShowAnswer ? normalizeString(source.moonTitleUrl) : "",
    acceptedAnswer: canShowAnswer ? normalizeString(source.acceptedAnswer) : "",
    canRevealAnswer: includeActiveAnswer === true,
    answerHidden: source.status === "open" && includeActiveAnswer !== true
  };
};

const latestRoundFromState = (state) =>
  [...normalizeArray(state.rounds)].reverse().find((round) => normalizeString(round.id)) || null;

const guessesForRound = (state, roundId, {includeContent = true, limit = 12} = {}) =>
  normalizeArray(state.guesses)
    .filter((guess) => guess.roundId === roundId)
    .slice(-Math.max(1, limit))
    .reverse()
    .map((guess) => ({
      id: guess.id,
      roundId: guess.roundId,
      discordUserId: guess.discordUserId,
      username: guess.username,
      content: includeContent ? guess.content : "",
      normalized: includeContent ? guess.normalized : "",
      correct: guess.correct,
      close: guess.close,
      matchedBy: guess.matchedBy,
      aiNote: includeContent ? guess.aiNote : "",
      createdAt: guess.createdAt,
      redacted: includeContent !== true
    }));

const levenshtein = (left, right) => {
  if (left === right) {
    return 0;
  }
  if (!left.length) {
    return right.length;
  }
  if (!right.length) {
    return left.length;
  }
  const previous = Array.from({length: right.length + 1}, (_value, index) => index);
  const current = new Array(right.length + 1);
  for (let i = 0; i < left.length; i += 1) {
    current[0] = i + 1;
    for (let j = 0; j < right.length; j += 1) {
      current[j + 1] = Math.min(
        current[j] + 1,
        previous[j + 1] + 1,
        previous[j] + (left[i] === right[j] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
};

const matchGuess = (round, content) => {
  const raw = normalizeString(content);
  const guessText = normalizeGuessText(raw);
  const normalizedGuess = slug(guessText);
  const urls = [round.sourceUrl, round.moonTitleUrl].map((entry) => normalizeString(entry).toLowerCase()).filter(Boolean);
  if (urls.some((url) => raw.toLowerCase().includes(url))) {
    return {correct: true, close: false, matchedBy: "url", normalizedGuess};
  }
  if (!normalizedGuess || normalizedGuess.length < 2) {
    return {correct: false, close: false, matchedBy: "", normalizedGuess};
  }

  const answers = titleTerms(round).map((entry) => slug(entry)).filter(Boolean);
  if (answers.includes(normalizedGuess)) {
    return {correct: true, close: false, matchedBy: "exact", normalizedGuess};
  }
  if (answers.some((answer) => answer.length >= 5 && normalizedGuess.includes(answer))) {
    return {correct: true, close: false, matchedBy: "contains", normalizedGuess};
  }

  let bestDistance = Number.MAX_SAFE_INTEGER;
  let bestLength = 0;
  for (const answer of answers) {
    if (answer.length < 4 || normalizedGuess.length < 4) {
      continue;
    }
    const distance = levenshtein(normalizedGuess, answer);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestLength = Math.max(answer.length, normalizedGuess.length);
    }
  }
  const ratio = bestLength ? bestDistance / bestLength : 1;
  const correct = bestLength >= 6 && (bestDistance <= 2 || ratio <= 0.22);
  const close = !correct && bestLength >= 6 && ratio <= 0.34;
  return {correct, close, matchedBy: correct ? "fuzzy" : close ? "close" : "", normalizedGuess};
};

const parseAiMatchDecision = (payload) => {
  const text = normalizeString(payload?.text || payload?.reply);
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text.replace(/^```json/i, "").replace(/```$/i, "").trim());
    if (parsed && typeof parsed === "object") {
      return {
        matched: parsed.matched === true,
        confidence: Number(parsed.confidence || 0),
        reason: normalizeString(parsed.reason)
      };
    }
  } catch {
    return null;
  }
  return null;
};

const userStreakBefore = (state, discordUserId) => {
  let streak = 0;
  for (const event of [...state.scoreEvents].reverse()) {
    if (event.discordUserId === discordUserId) {
      streak += 1;
      continue;
    }
    if (event.roundId) {
      break;
    }
  }
  return streak;
};

const scoreForWin = ({state, round, settings, discordUserId, wonAt = new Date()}) => {
  const baseXp = normalizeInteger(settings.baseXp, 10);
  const roundDurationMs = Math.max(1, parseDateMs(round.expiresAt) - parseDateMs(round.startedAt));
  const elapsedMs = Math.max(0, wonAt.getTime() - parseDateMs(round.startedAt));
  const remainingRatio = Math.max(0, 1 - (elapsedMs / roundDurationMs));
  const speedBonus = Math.round(normalizeInteger(settings.speedBonusMax, 5) * remainingRatio);
  const streak = userStreakBefore(state, discordUserId) + 1;
  const streakBonus = Math.min(
    normalizeInteger(settings.streakBonusMax, 10),
    Math.max(0, streak - 1) * normalizeInteger(settings.streakBonusPerWin, 2)
  );
  return {
    baseXp,
    speedBonus,
    streakBonus,
    streak,
    xp: baseXp + speedBonus + streakBonus
  };
};

const windowStartFor = (windowName, at = new Date()) => {
  const start = new Date(at);
  if (windowName === "monthly") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (windowName === "weekly") {
    const day = start.getDay();
    start.setDate(start.getDate() - day);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (windowName === "all") {
    return new Date(0);
  }
  start.setHours(0, 0, 0, 0);
  return start;
};

const buildLeaderboard = (state, windowName = "daily", limit = 10) => {
  const normalizedWindow = ["daily", "weekly", "monthly", "all"].includes(windowName) ? windowName : "daily";
  const since = windowStartFor(normalizedWindow).getTime();
  const rowsByUser = new Map();
  for (const event of state.scoreEvents) {
    if (parseDateMs(event.createdAt) < since) {
      continue;
    }
    const key = event.discordUserId;
    const current = rowsByUser.get(key) || {
      discordUserId: key,
      username: event.username,
      xp: 0,
      wins: 0,
      bestStreak: 0,
      lastWinAt: ""
    };
    current.username = event.username || current.username;
    current.xp += event.xp;
    current.wins += 1;
    current.bestStreak = Math.max(current.bestStreak, event.streak);
    current.lastWinAt = event.createdAt;
    rowsByUser.set(key, current);
  }
  return {
    window: normalizedWindow,
    generatedAt: nowIso(),
    rows: Array.from(rowsByUser.values())
      .sort((left, right) => right.xp - left.xp || right.wins - left.wins || left.username.localeCompare(right.username))
      .slice(0, Math.max(1, limit))
      .map((row, index) => ({...row, rank: index + 1}))
  };
};

const nextRoundAfter = (settings = {}) => {
  const min = normalizeInteger(settings.cooldownMinMinutes, 30);
  const max = Math.max(min, normalizeInteger(settings.cooldownMaxMinutes, 180));
  const offsetMinutes = min + Math.floor(Math.random() * ((max - min) + 1));
  return new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();
};

/**
 * Create the Sage trivia service facade.
 *
 * @param {{
 *   config: Record<string, unknown>,
 *   vaultClient: {getSetting: Function, setSetting: Function},
 *   serviceJson: Function,
 *   readPortalDiscordSettings: () => Promise<Record<string, unknown>>
 * }} options
 * @returns {Record<string, Function>}
 */
export const createPortalTriviaService = ({config, vaultClient, serviceJson, readPortalDiscordSettings}) => {
  const loadLibrary = async () => {
    const result = await serviceJson(config.ravenBaseUrl, "/v1/library", {timeoutMs: 5000});
    if (!result.ok) {
      throw new Error(result.payload?.error || "Raven library is unavailable.");
    }
    return normalizeArray(result.payload?.titles);
  };

  const maybeAiMatchGuess = async ({settings, round, content, match}) => {
    if (match.correct || !match.close || settings.aiMatchingEnabled === false) {
      return match;
    }
    try {
      const result = await serviceJson(config.oracleBaseUrl, "/api/assist", {
        method: "POST",
        body: {
          task: "match-title",
          prompt: content,
          context: {
            title: round.title,
            aliases: round.aliases,
            sourceUrl: round.sourceUrl,
            moonTitleUrl: round.moonTitleUrl
          }
        },
        timeoutMs: ORACLE_MATCH_TIMEOUT_MS
      });
      const decision = parseAiMatchDecision(result.payload || result);
      if (decision?.matched && decision.confidence >= 0.78) {
        return {
          ...match,
          correct: true,
          close: false,
          matchedBy: "ai",
          aiNote: decision.reason
        };
      }
      return {
        ...match,
        aiNote: decision?.reason || normalizeString(result.payload?.text)
      };
    } catch {
      return match;
    }
  };

  const service = {
    async getState() {
      const [state, settings] = await Promise.all([
        readState(vaultClient),
        readPortalDiscordSettings()
      ]);
      return {
        settings: settings.trivia,
        activeRound: roundPublicPayload(activeRoundFromState(state)),
        nextRoundAfter: state.nextRoundAfter,
        leaderboard: buildLeaderboard(state, "daily"),
        rounds: state.rounds.map(roundPublicPayload).reverse().slice(0, 20)
      };
    },

    async getAdminState({includeActiveAnswer = false} = {}) {
      const [state, settings] = await Promise.all([
        readState(vaultClient),
        readPortalDiscordSettings()
      ]);
      const activeRound = activeRoundFromState(state);
      const latestRound = activeRound || latestRoundFromState(state);
      const canShowGuessContent = !latestRound || latestRound.status !== "open" || includeActiveAnswer;
      return {
        settings: settings.trivia,
        activeRound: roundAdminPayload(activeRound, {includeActiveAnswer}),
        latestRound: roundAdminPayload(latestRound, {includeActiveAnswer}),
        recentGuesses: latestRound?.id
          ? guessesForRound(state, latestRound.id, {includeContent: canShowGuessContent})
          : [],
        nextRoundAfter: state.nextRoundAfter,
        leaderboard: buildLeaderboard(state, "daily"),
        rounds: state.rounds.map((round) => roundAdminPayload(round, {includeActiveAnswer})).reverse().slice(0, 20),
        canRevealActiveAnswer: includeActiveAnswer === true,
        generatedAt: nowIso()
      };
    },

    async startRound({requestedBy = "scriptarr-portal", force = false} = {}) {
      const settings = (await readPortalDiscordSettings()).trivia || {};
      if (!settings.channelId) {
        return {ok: false, status: 409, error: "Trivia channel id is required."};
      }
      if (!settings.enabled && !force) {
        return {ok: false, status: 409, error: "Trivia is disabled."};
      }

      const state = await readState(vaultClient);
      const existing = activeRoundFromState(state);
      if (existing) {
        return {
          ok: true,
          reused: true,
          channelId: settings.channelId,
          round: roundPublicPayload(existing)
        };
      }

      const titles = eligibleTriviaTitles(config, await loadLibrary());
      if (!titles.length) {
        return {ok: false, status: 409, error: "No trivia-ready titles with usable summaries were found."};
      }
      const selected = pickTitle(titles, state);
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + normalizeInteger(settings.roundDurationMinutes, 20) * 60 * 1000);
      const round = normalizeRound({
        ...selected,
        id: `trivia_${startedAt.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        status: "open",
        startedAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        createdBy: requestedBy
      });
      const nextState = normalizeState({
        ...state,
        activeRoundId: round.id,
        rounds: [...state.rounds, round]
      });
      await writeState(vaultClient, nextState);
      return {
        ok: true,
        channelId: settings.channelId,
        round: roundPublicPayload(round),
        prompt: `Scriptarr trivia: guess the title from this summary.\n\n${round.prompt}\n\nFirst correct answer wins. This round ends <t:${Math.floor(expiresAt.getTime() / 1000)}:R>.`
      };
    },

    async stopRound({requestedBy = "scriptarr"} = {}) {
      const state = await readState(vaultClient);
      const active = activeRoundFromState(state);
      if (!active) {
        return {ok: true, stopped: false};
      }
      const ended = normalizeRound({
        ...active,
        status: "cancelled",
        endedAt: nowIso(),
        createdBy: requestedBy || active.createdBy
      });
      await writeState(vaultClient, {
        ...state,
        activeRoundId: "",
        rounds: state.rounds.map((round) => round.id === ended.id ? ended : round)
      });
      return {ok: true, stopped: true, round: roundPublicPayload(ended), answer: ended.title};
    },

    async recordGuess({roundId, discordUserId, username, content, messageId = ""} = {}) {
      const state = await readState(vaultClient);
      const active = activeRoundFromState(state);
      if (!active || active.id !== roundId) {
        return {ok: true, correct: false, ignored: true, reason: "No active trivia round."};
      }
      const normalizedMessageId = normalizeString(messageId);
      if (normalizedMessageId) {
        const existingGuess = state.guesses.find((guess) =>
          guess.roundId === active.id && guess.id === normalizedMessageId
        );
        if (existingGuess) {
          return {
            ok: true,
            duplicate: true,
            correct: existingGuess.correct,
            close: existingGuess.close,
            guess: existingGuess
          };
        }
      }
      const settings = (await readPortalDiscordSettings()).trivia || {};
      const match = await maybeAiMatchGuess({
        settings,
        round: active,
        content,
        match: matchGuess(active, content)
      });
      const createdAt = new Date();
      const guess = normalizeGuess({
        id: messageId || `guess_${createdAt.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        roundId: active.id,
        discordUserId,
        username,
        content,
        normalized: match.normalizedGuess,
        correct: match.correct,
        close: match.close,
        matchedBy: match.matchedBy,
        aiNote: match.aiNote,
        createdAt: createdAt.toISOString()
      });

      if (!match.correct) {
        await writeState(vaultClient, {
          ...state,
          guesses: [...state.guesses, guess]
        });
        return {ok: true, correct: false, close: match.close};
      }

      const score = scoreForWin({state, round: active, settings, discordUserId, wonAt: createdAt});
      const ended = normalizeRound({
        ...active,
        status: "won",
        endedAt: createdAt.toISOString(),
        winnerDiscordUserId: discordUserId,
        winnerUsername: username,
        acceptedAnswer: content
      });
      const scoreEvent = normalizeScoreEvent({
        id: `score_${ended.id}_${discordUserId}`,
        roundId: ended.id,
        discordUserId,
        username,
        ...score,
        createdAt: createdAt.toISOString()
      });
      const nextState = normalizeState({
        ...state,
        activeRoundId: "",
        rounds: state.rounds.map((round) => round.id === ended.id ? ended : round),
        guesses: [...state.guesses, guess],
        scoreEvents: [...state.scoreEvents, scoreEvent],
        nextRoundAfter: nextRoundAfter(settings)
      });
      await writeState(vaultClient, nextState);
      return {
        ok: true,
        correct: true,
        answer: ended.title,
        round: roundPublicPayload(ended),
        guess,
        score: scoreEvent,
        scoreEvent,
        leaderboard: buildLeaderboard(nextState, "daily")
      };
    },

    async timeoutRound(roundId) {
      const state = await readState(vaultClient);
      const active = activeRoundFromState(state);
      if (!active || active.id !== roundId) {
        return {ok: true, timedOut: false};
      }
      const ended = normalizeRound({
        ...active,
        status: "timeout",
        endedAt: nowIso()
      });
      const settings = (await readPortalDiscordSettings()).trivia || {};
      await writeState(vaultClient, {
        ...state,
        activeRoundId: "",
        nextRoundAfter: nextRoundAfter(settings),
        rounds: state.rounds.map((round) => round.id === ended.id ? ended : round)
      });
      return {ok: true, timedOut: true, answer: ended.title, round: roundPublicPayload(ended)};
    },

    async postHint(roundId, hintMinute) {
      const state = await readState(vaultClient);
      const active = activeRoundFromState(state);
      const minute = normalizeInteger(hintMinute, 0);
      if (!active || active.id !== roundId || !minute || active.hintsPosted.includes(minute)) {
        return {ok: true, posted: false};
      }
      const hint = {
        minute,
        text: `Hint: this is a ${active.libraryTypeSlug} title with ${active.title.length} characters in its main name.`,
        postedAt: nowIso()
      };
      const nextRound = normalizeRound({
        ...active,
        hintsPosted: [...active.hintsPosted, minute]
      });
      await writeState(vaultClient, {
        ...state,
        rounds: state.rounds.map((round) => round.id === nextRound.id ? nextRound : round)
      });
      return {ok: true, posted: true, hint, round: roundPublicPayload(nextRound)};
    },

    async leaderboard(windowName = "daily", limit = 10) {
      return buildLeaderboard(await readState(vaultClient), windowName, limit);
    },

    async acknowledgeLeaderboard(postId) {
      const state = await readState(vaultClient);
      const normalized = normalizeString(postId);
      if (normalized && !state.leaderboardAcks.includes(normalized)) {
        await writeState(vaultClient, {
          ...state,
          leaderboardAcks: [...state.leaderboardAcks, normalized]
        });
      }
      return {ok: true, postId: normalized};
    }
  };

  return service;
};

export default {
  createPortalTriviaService
};
