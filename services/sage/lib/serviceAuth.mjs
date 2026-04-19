/**
 * @file Scriptarr Sage module: services/sage/lib/serviceAuth.mjs.
 */

const getBearerToken = (header) => {
  if (!header) {
    return "";
  }
  const [scheme, token] = String(header).split(" ");
  return scheme?.toLowerCase() === "bearer" ? token || "" : "";
};

/**
 * Create a Sage internal-service auth middleware factory. The caller is
 * resolved from `SCRIPTARR_SERVICE_TOKENS`, and individual routes can restrict
 * which first-party services are allowed to use them.
 *
 * @param {{serviceTokens?: Record<string, string>}} config
 * @returns {(allowedServices: string | string[]) => import("express").RequestHandler}
 */
export const createServiceAuth = (config) => {
  const tokenToService = new Map(
    Object.entries(config.serviceTokens || {})
      .filter(([, token]) => typeof token === "string" && token.trim())
      .map(([serviceName, token]) => [token, serviceName])
  );

  return (allowedServices) => {
    const allowed = new Set(Array.isArray(allowedServices) ? allowedServices : [allowedServices]);
    return async (req, res, next) => {
      const token = getBearerToken(req.headers.authorization);
      const serviceName = tokenToService.get(token);
      if (!serviceName) {
        res.status(401).json({error: "Missing or invalid service token."});
        return;
      }
      if (allowed.size && !allowed.has(serviceName)) {
        res.status(403).json({error: "This service is not allowed to call that broker route."});
        return;
      }
      req.serviceName = serviceName;
      next();
    };
  };
};

export default createServiceAuth;
