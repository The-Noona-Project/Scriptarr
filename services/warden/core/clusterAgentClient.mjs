/**
 * @file Bounded, mutually authenticated Warden-to-Warden requests.
 */
import https from "node:https";
import {readFileSync} from "node:fs";
import {checkServerIdentity} from "node:tls";

/**
 * Load explicit certificate material for both the server and outbound agent requests.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options] certificate paths
 * @returns {object} TLS credentials with certificate validation enabled
 */
export const resolveClusterTlsOptions = ({env = process.env} = {}) => {
  const paths = ["CA", "CERT", "KEY"].map((key) => env[`SCRIPTARR_WARDEN_TLS_${key}_FILE`]);
  if (paths.some((value) => !value)) {
    throw new Error("Multi-host Warden requires CA, certificate and private-key file paths.");
  }
  return {ca: readFileSync(paths[0]), cert: readFileSync(paths[1]), key: readFileSync(paths[2]), rejectUnauthorized: true};
};

/**
 * Build an HTTPS client restricted to hosts from the validated topology.
 *
 * @param {{env?: NodeJS.ProcessEnv, tlsOptions?: object}} [options] runtime credentials
 * @returns {{request: Function}} request client
 */
export const createClusterAgentClient = ({env = process.env, tlsOptions} = {}) => {
  let material = tlsOptions;
  return {
    request(host, path, {method = "GET", body} = {}) {
      material ||= resolveClusterTlsOptions({env});
      const destination = new URL(path, host.agentUrl);
      if (destination.origin !== host.agentUrl || !path.startsWith("/api/")) {
        return Promise.reject(new Error("Agent request destination is outside the configured control API."));
      }
      const encoded = body == null ? undefined : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        const request = https.request(destination, {
          ...material,
          method,
          checkServerIdentity(serverName, certificate) {
            const mismatch = checkServerIdentity(serverName, certificate);
            if (mismatch) return mismatch;
            if (certificate.subject?.CN !== host.id) return new Error("Agent certificate does not match its configured host identity.");
            return undefined;
          },
          headers: {
            Authorization: `Bearer ${env.SCRIPTARR_WARDEN_SERVICE_TOKEN || "warden-dev-token"}`,
            "Content-Type": "application/json",
            ...(encoded ? {"Content-Length": Buffer.byteLength(encoded)} : {})
          }
        }, (response) => {
          let payload = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            payload += chunk;
            if (Buffer.byteLength(payload) > 1024 * 1024) {
              request.destroy(new Error("Agent response exceeded the bounded response limit."));
            }
          });
          response.on("error", reject);
          response.on("end", () => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
              reject(Object.assign(new Error(`Agent ${host.id} returned HTTP ${response.statusCode}.`), {status: response.statusCode}));
              return;
            }
            try {
              resolve(JSON.parse(payload));
            } catch {
              reject(new Error(`Agent ${host.id} returned invalid JSON.`));
            }
          });
        });
        const timeout = Math.min(15000, Math.max(1000, Number(env.SCRIPTARR_WARDEN_AGENT_TIMEOUT_MS) || 4000));
        const timer = setTimeout(() => request.destroy(new Error(`Agent ${host.id} request timed out.`)), timeout);
        request.on("error", reject);
        request.on("close", () => clearTimeout(timer));
        request.end(encoded);
      });
    }
  };
};
