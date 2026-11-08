/** @file Dedicated verified-TLS ingress for the restricted Raven conversion worker. */
import express from "express";
import {createServer} from "node:https";
import {readFileSync} from "node:fs";
import {createServiceAuth} from "./serviceAuth.mjs";

/**
 * Create an optional worker-only TLS server without changing Sage's existing HTTP server.
 * @param {{app: import("express").Express, config: object}} options Application and resolved configuration.
 * @returns {import("node:https").Server|null} Unstarted server, or null when worker ingress is disabled.
 */
export const createWorkerTlsServer = ({app, config}) => {
  if (config.workerTlsPort == null || config.workerTlsPort === 0) return null;
  if (!Number.isInteger(config.workerTlsPort) || config.workerTlsPort < 1 || config.workerTlsPort > 65535
    || config.workerTlsPort === config.port || !config.workerTlsCertFile || !config.workerTlsKeyFile
    || !config.serviceTokens?.["scriptarr-raven-worker"]) throw new Error("Worker HTTPS requires a distinct port, certificate, key, and restricted worker identity.");
  const worker = express();
  worker.get("/health", (_req, res) => res.json({ok: true, service: "sage-worker-broker"}));
  worker.use((req, res, next) => {
    if (!/^\/api\/internal\/raven-ingest\/(?:claims|workers\/(?:heartbeat|status)|jobs\/[A-Za-z0-9_.:-]{1,160}\/(?:heartbeat|fail|input|artifact))$/.test(req.path)) {
      res.status(404).json({error: "Worker broker route not found."}); return;
    }
    next();
  });
  worker.use(createServiceAuth(config)(["scriptarr-raven-worker"]));
  worker.use(app);
  const server = createServer({key: readFileSync(config.workerTlsKeyFile), cert: readFileSync(config.workerTlsCertFile), minVersion: "TLSv1.2"}, worker);
  server.requestTimeout = 15 * 60 * 1000 + 5000;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  return server;
};
