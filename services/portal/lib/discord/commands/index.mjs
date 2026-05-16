import {createDingCommand} from "./dingCommand.mjs";
import {createStatusCommand} from "./statusCommand.mjs";
import {createChatCommand} from "./chatCommand.mjs";
import {createSearchCommand} from "./searchCommand.mjs";
import {createRequestCommand} from "./requestCommand.mjs";
import {createSubscribeCommand} from "./subscribeCommand.mjs";
import {createDownloadAllCommand} from "./downloadAllCommand.mjs";
import {createTriviaCommand} from "./triviaCommand.mjs";

export const createPortalCommands = ({
  sage,
  publicBaseUrl,
  getBrandName,
  getSettings,
  logger,
  onRuntimeEvent,
  onTriviaStart,
  onTriviaStop,
  onTriviaLeaderboard
}) => {
  const commands = new Map();
  commands.set("ding", createDingCommand({getBrandName}));
  commands.set("status", createStatusCommand({sage, getBrandName}));
  commands.set("chat", createChatCommand({sage}));
  commands.set("search", createSearchCommand({sage, publicBaseUrl, getBrandName}));
  commands.set("request", createRequestCommand({sage, getBrandName}));
  commands.set("subscribe", createSubscribeCommand({sage, getBrandName}));
  commands.set("downloadall", createDownloadAllCommand({
    sage,
    getBrandName,
    getSettings,
    logger,
    onRuntimeEvent
  }));
  commands.set("trivia", createTriviaCommand({
    sage,
    onTriviaStart,
    onTriviaStop,
    onTriviaLeaderboard
  }));
  return commands;
};
