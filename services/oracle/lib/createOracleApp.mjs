import express from "express";
import {resolveOracleConfig} from "./config.mjs";
import {createOracleClient} from "./oracleClient.mjs";
import {readScriptarrStatus} from "./readStatus.mjs";
import {createVaultClient} from "./vaultClient.mjs";
import {resolveOracleRuntimeSettings} from "./runtimeSettings.mjs";

const probeLocalAi = async (runtime) => {
  const modelsUrl = `${runtime.localAiBaseUrl.replace(/\/v1$/, "")}/v1/models`;
  try {
    const response = await fetch(modelsUrl, {
      signal: AbortSignal.timeout(1200)
    });
    return response.ok;
  } catch {
    return false;
  }
};

export const createOracleApp = async () => {
  const config = resolveOracleConfig();
  const vaultClient = createVaultClient(config);
  const app = express();
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    const [status, runtime] = await Promise.all([
      readScriptarrStatus(config),
      resolveOracleRuntimeSettings({config, vaultClient})
    ]);
    res.json({
      ok: true,
      service: "scriptarr-oracle",
      persona: config.noonaPersonaName,
      enabled: runtime.enabled,
      provider: runtime.provider,
      model: runtime.model,
      localAiBaseUrl: runtime.localAiBaseUrl,
      openAiApiKeyConfigured: runtime.openAiApiKeyConfigured,
      status
    });
  });

  app.get("/api/status", async (_req, res) => {
    const [status, runtime] = await Promise.all([
      readScriptarrStatus(config),
      resolveOracleRuntimeSettings({config, vaultClient})
    ]);
    res.json({
      ...status,
      oracle: {
        enabled: runtime.enabled,
        provider: runtime.provider,
        model: runtime.model
      }
    });
  });

  app.post("/api/chat", async (req, res) => {
    const message = String(req.body.message || "").trim();
    if (!message) {
      res.status(400).json({error: "message is required."});
      return;
    }

    const [status, runtime] = await Promise.all([
      readScriptarrStatus(config),
      resolveOracleRuntimeSettings({config, vaultClient})
    ]);
    if (/status|health|boot|callback/i.test(message)) {
      res.json({
        ok: true,
        reply: `${config.noonaPersonaName} checked Scriptarr. ${status.ok ? "The stack responded." : "The stack status is currently degraded."}${runtime.enabled ? ` Oracle is using ${runtime.provider}.` : " Oracle is currently off."}`,
        status
      });
      return;
    }

    if (!runtime.enabled) {
      res.json({
        ok: true,
        disabled: true,
        reply: `${config.noonaPersonaName} is currently off. Add an OpenAI API key or switch to LocalAI from Moon admin, then enable Oracle when you're ready.`,
        status
      });
      return;
    }

    if (runtime.provider === "openai" && !runtime.openAiApiKeyConfigured) {
      res.json({
        ok: true,
        disabled: true,
        reply: `${config.noonaPersonaName} is configured for OpenAI, but the API key has not been set yet.`,
        status
      });
      return;
    }

    try {
      const localAiAvailable = runtime.provider !== "localai" || await probeLocalAi(runtime);
      if (!localAiAvailable) {
        res.json({
          ok: true,
          degraded: true,
          reply: `${config.noonaPersonaName} is in read-only fallback mode because LocalAI is unavailable right now.`,
          status,
          error: "LocalAI probe failed."
        });
        return;
      }
      const llm = createOracleClient(runtime);
      const result = await llm.invoke([
        ["system", `You are ${config.noonaPersonaName}, the friendly Scriptarr AI persona. Answer briefly. You may discuss Scriptarr status, Moon, Raven, Vault, Portal, Oracle, LocalAI, and the manga/comics workflow. Do not claim you can trigger actions or mutate the system.`],
        ["human", message]
      ]);
      res.json({
        ok: true,
        reply: typeof result?.content === "string" ? result.content : JSON.stringify(result?.content),
        status
      });
    } catch (error) {
      res.json({
        ok: true,
        degraded: true,
        reply: `${config.noonaPersonaName} is in read-only fallback mode because LocalAI is unavailable right now.`,
        status,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return {app, config};
};
