/**
 * @file Enforce service-token authorization and mutually authenticated host identities.
 */
import {timingSafeEqual} from "node:crypto";
import https from "node:https";
import {resolveClusterTopology} from "../config/clusterTopology.mjs";
import {resolveClusterTlsOptions} from "../core/clusterAgentClient.mjs";

const normalizeAddress = (value) => String(value || "").replace(/^::ffff:/, "");

/**
 * Create the authorization gate for all Warden control API routes.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options] runtime token
 * @returns {Function} Express middleware
 */
export const createWardenControlAuthorization = ({env = process.env} = {}) => {
  const expected = Buffer.from(env.SCRIPTARR_WARDEN_SERVICE_TOKEN || "warden-dev-token");
  return (req, res, next) => {
    const match = /^Bearer (.+)$/i.exec(req.headers.authorization || "");
    const received = Buffer.from(match?.[1] || "");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      res.status(401).json({error: "Warden control authorization is required."});
      return;
    }
    next();
  };
};

/**
 * Authorize an already TLS-verified client certificate against the topology and peer IP.
 *
 * @param {object} socket TLS socket
 * @param {object} topology validated topology
 * @returns {boolean} whether the peer is the configured primary host
 */
export const isAuthorizedClusterPeer = (socket, topology) => {
  if (!socket.authorized) return false;
  const certificate = socket.getPeerCertificate();
  const peer = topology.hosts.find((host) => host.id === certificate.subject?.CN);
  return Boolean(peer && peer.id === topology.primaryHostId
    && normalizeAddress(socket.remoteAddress) === normalizeAddress(peer.address));
};

/**
 * Construct a separate HTTPS listener for cross-host control, leaving HTTP private to Docker.
 *
 * @param {Function} app Express request handler
 * @param {{env?: NodeJS.ProcessEnv, tlsOptions?: object}} [options] credentials and topology
 * @returns {import("node:https").Server | null} unbound mTLS listener or null for single-host mode
 */
export const createWardenClusterServer = (app, {env = process.env, tlsOptions} = {}) => {
  const topology = resolveClusterTopology({env});
  if (!topology.enabled) return null;
  const material = tlsOptions || resolveClusterTlsOptions({env});
  return https.createServer({...material, requestCert: true, rejectUnauthorized: true}, (req, res) => {
    if (!isAuthorizedClusterPeer(req.socket, topology)) {
      res.writeHead(403, {"Content-Type": "application/json"});
      res.end(JSON.stringify({error: "The client certificate and peer address are not an authorized primary host."}));
      return;
    }
    app(req, res);
  });
};
