import {createDingCommand} from "./dingCommand.mjs";
import {createStatusCommand} from "./statusCommand.mjs";
import {createChatCommand} from "./chatCommand.mjs";
import {createSearchCommand} from "./searchCommand.mjs";
import {createRequestCommand} from "./requestCommand.mjs";
import {createSubscribeCommand} from "./subscribeCommand.mjs";
import {createDownloadAllCommand} from "./downloadAllCommand.mjs";

export const createPortalCommands = ({sage, publicBaseUrl, getSettings, logger, onRuntimeEvent}) => {
  const commands = new Map();
  commands.set("ding", createDingCommand());
  commands.set("status", createStatusCommand({sage}));
  commands.set("chat", createChatCommand({sage}));
  commands.set("search", createSearchCommand({sage, publicBaseUrl}));
  commands.set("request", createRequestCommand({sage}));
  commands.set("subscribe", createSubscribeCommand({sage}));
  commands.set("downloadall", createDownloadAllCommand({
    sage,
    getSettings,
    logger,
    onRuntimeEvent
  }));
  return commands;
};
