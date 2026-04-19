import {ChatOpenAI} from "@langchain/openai";

export const createOracleClient = (runtime) => new ChatOpenAI({
  model: runtime.model,
  temperature: runtime.temperature,
  timeout: 1500,
  apiKey: runtime.apiKey,
  ...(runtime.provider === "localai"
    ? {
      configuration: {
        baseURL: runtime.localAiBaseUrl
      }
    }
    : {})
});
