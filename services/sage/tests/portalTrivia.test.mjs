import test from "node:test";
import assert from "node:assert/strict";
import {createPortalTriviaService} from "../lib/portalTrivia.mjs";

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

const triviaReadyTitle = () => ({
  id: "title-1",
  title: "Ancient Bakery",
  aliases: ["Flour Mage"],
  libraryTypeSlug: "manga",
  sourceUrl: "https://weebcentral.com/series/ancient-bakery",
  summary: "Ancient Bakery follows a wandering apprentice who discovers a moonlit shop where every pastry remembers a forgotten spell, then protects the neighborhood with recipes, courage, and careful friendships."
});

test("portal trivia starts sanitized rounds and awards XP for aliases", async () => {
  const vault = createMemoryVault();
  const service = createPortalTriviaService({
    config: {publicBaseUrl: "https://pax-kun.com", ravenBaseUrl: "http://raven", oracleBaseUrl: "http://oracle"},
    vaultClient: vault,
    readPortalDiscordSettings: async () => ({
      trivia: {
        enabled: true,
        channelId: "trivia-channel",
        roundDurationMinutes: 20,
        baseXp: 10,
        speedBonusMax: 5,
        streakBonusPerWin: 2,
        streakBonusMax: 10
      }
    }),
    serviceJson: async (_baseUrl, path) => {
      if (path === "/v1/library") {
        return {
          ok: true,
          status: 200,
          payload: {
            titles: [
              triviaReadyTitle(),
              {...triviaReadyTitle(), id: "adult-1", title: "Adult Skip", tags: ["adult"]}
            ]
          }
        };
      }
      return {ok: true, status: 200, payload: {ok: true}};
    }
  });

  const started = await service.startRound({requestedBy: "tester", force: true});
  assert.equal(started.ok, true);
  assert.equal(started.round.title, "");
  assert.match(started.round.prompt, /____/);
  assert.doesNotMatch(started.round.prompt, /Ancient Bakery/i);

  const wrong = await service.recordGuess({
    roundId: started.round.id,
    discordUserId: "user-1",
    username: "Reader",
    content: "totally different"
  });
  assert.equal(wrong.correct, false);

  const winner = await service.recordGuess({
    roundId: started.round.id,
    discordUserId: "user-1",
    username: "Reader",
    content: "Flour Mage"
  });
  assert.equal(winner.correct, true);
  assert.equal(winner.round.title, "Ancient Bakery");
  assert.equal(winner.guess.matchedBy, "exact");
  assert.ok(winner.scoreEvent.xp >= 10);

  const state = await service.getState();
  assert.equal(state.activeRound, null);
  assert.equal(state.leaderboard.rows[0].discordUserId, "user-1");
});

test("portal trivia exposes active answers only through admin state", async () => {
  const vault = createMemoryVault();
  const service = createPortalTriviaService({
    config: {publicBaseUrl: "https://pax-kun.com", ravenBaseUrl: "http://raven", oracleBaseUrl: "http://oracle"},
    vaultClient: vault,
    readPortalDiscordSettings: async () => ({
      trivia: {
        enabled: true,
        channelId: "trivia-channel",
        roundDurationMinutes: 20
      }
    }),
    serviceJson: async (_baseUrl, path) => {
      if (path === "/v1/library") {
        return {ok: true, status: 200, payload: {titles: [triviaReadyTitle()]}};
      }
      return {ok: true, status: 200, payload: {ok: true}};
    }
  });

  await service.startRound({force: true});

  const publicState = await service.getState();
  assert.equal(publicState.activeRound.title, "");

  const hiddenAdminState = await service.getAdminState({includeActiveAnswer: false});
  assert.equal(hiddenAdminState.activeRound.answerHidden, true);
  assert.equal(hiddenAdminState.activeRound.answer, "");

  const revealedAdminState = await service.getAdminState({includeActiveAnswer: true});
  assert.equal(revealedAdminState.activeRound.answer, "Ancient Bakery");
  assert.deepEqual(revealedAdminState.activeRound.aliases, ["Flour Mage"]);
  assert.match(revealedAdminState.activeRound.moonTitleUrl, /\/title\/manga\/title-1/);
});

test("portal trivia de-duplicates guesses by Discord message id", async () => {
  const vault = createMemoryVault();
  const service = createPortalTriviaService({
    config: {publicBaseUrl: "https://pax-kun.com", ravenBaseUrl: "http://raven", oracleBaseUrl: "http://oracle"},
    vaultClient: vault,
    readPortalDiscordSettings: async () => ({
      trivia: {
        enabled: true,
        channelId: "trivia-channel",
        roundDurationMinutes: 20
      }
    }),
    serviceJson: async (_baseUrl, path) => {
      if (path === "/v1/library") {
        return {ok: true, status: 200, payload: {titles: [triviaReadyTitle()]}};
      }
      return {ok: true, status: 200, payload: {ok: true}};
    }
  });

  const started = await service.startRound({force: true});
  const first = await service.recordGuess({
    roundId: started.round.id,
    discordUserId: "user-1",
    username: "Reader",
    content: "not it",
    messageId: "discord-message-1"
  });
  const duplicate = await service.recordGuess({
    roundId: started.round.id,
    discordUserId: "user-1",
    username: "Reader",
    content: "not it",
    messageId: "discord-message-1"
  });

  assert.equal(first.correct, false);
  assert.equal(duplicate.duplicate, true);

  const adminState = await service.getAdminState({includeActiveAnswer: true});
  assert.equal(adminState.recentGuesses.length, 1);
});

test("portal trivia accepts Jeopardy-style title and alias guesses", async () => {
  const createService = () => createPortalTriviaService({
    config: {publicBaseUrl: "https://pax-kun.com", ravenBaseUrl: "http://raven", oracleBaseUrl: "http://oracle"},
    vaultClient: createMemoryVault(),
    readPortalDiscordSettings: async () => ({
      trivia: {
        enabled: true,
        channelId: "trivia-channel",
        roundDurationMinutes: 20
      }
    }),
    serviceJson: async (_baseUrl, path) => {
      if (path === "/v1/library") {
        return {ok: true, status: 200, payload: {titles: [triviaReadyTitle()]}};
      }
      return {ok: true, status: 200, payload: {ok: true}};
    }
  });

  const titleService = createService();
  const titleRound = await titleService.startRound({force: true});
  const titleGuess = await titleService.recordGuess({
    roundId: titleRound.round.id,
    discordUserId: "user-title",
    username: "Title Reader",
    content: "What is Ancient Bakery?"
  });
  assert.equal(titleGuess.correct, true);
  assert.equal(titleGuess.guess.matchedBy, "exact");

  const aliasService = createService();
  const aliasRound = await aliasService.startRound({force: true});
  const aliasGuess = await aliasService.recordGuess({
    roundId: aliasRound.round.id,
    discordUserId: "user-alias",
    username: "Alias Reader",
    content: "<@1264650629691740231> What are Flour Mage?"
  });
  assert.equal(aliasGuess.correct, true);
  assert.equal(aliasGuess.guess.matchedBy, "exact");

  const urlService = createService();
  const urlRound = await urlService.startRound({force: true});
  const urlGuess = await urlService.recordGuess({
    roundId: urlRound.round.id,
    discordUserId: "user-url",
    username: "URL Reader",
    content: "https://weebcentral.com/series/ancient-bakery"
  });
  assert.equal(urlGuess.correct, true);
  assert.equal(urlGuess.guess.matchedBy, "url");
});

test("portal trivia uses Oracle only for close guesses when enabled", async () => {
  const vault = createMemoryVault();
  let assistCalls = 0;
  let assistTimeoutMs = 0;
  const service = createPortalTriviaService({
    config: {publicBaseUrl: "https://pax-kun.com", ravenBaseUrl: "http://raven", oracleBaseUrl: "http://oracle"},
    vaultClient: vault,
    readPortalDiscordSettings: async () => ({
      trivia: {
        enabled: true,
        channelId: "trivia-channel",
        roundDurationMinutes: 20,
        aiMatchingEnabled: true
      }
    }),
    serviceJson: async (baseUrl, path, options = {}) => {
      if (path === "/v1/library") {
        return {ok: true, status: 200, payload: {titles: [triviaReadyTitle()]}};
      }
      if (baseUrl === "http://oracle" && path === "/api/assist") {
        assistCalls += 1;
        assistTimeoutMs = options.timeoutMs;
        return {
          ok: true,
          status: 200,
          payload: {
            text: "{\"matched\": true, \"confidence\": 0.9, \"reason\": \"close typo\"}"
          }
        };
      }
      return {ok: true, status: 200, payload: {ok: true}};
    }
  });

  const started = await service.startRound({force: true});
  const result = await service.recordGuess({
    roundId: started.round.id,
    discordUserId: "user-2",
    username: "Typo Reader",
    content: "ancient bakxxxxx"
  });

  assert.equal(assistCalls, 1);
  assert.equal(assistTimeoutMs, 5000);
  assert.equal(result.correct, true);
  assert.equal(result.guess.matchedBy, "ai");
});
