/**
 * @file Scriptarr Sage module: services/sage/lib/auth.mjs.
 */
const getBearerToken = (header) => {
  if (!header) {
    return "";
  }
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token || "" : "";
};

/**
 * Determine whether a signed-in user carries a specific permission or global
 * admin access.
 *
 * @param {{permissions?: string[]}} user
 * @param {string} permission
 * @returns {boolean}
 */
export const hasPermission = (user, permission) =>
  Boolean(user?.permissions?.includes("admin") || user?.permissions?.includes(permission));

/**
 * Build an Express middleware that resolves the current session user through
 * Vault's session APIs.
 *
 * @param {ReturnType<import("./vaultClient.mjs").createVaultClient>} vaultClient
 * @returns {import("express").RequestHandler}
 */
export const requireSession = (vaultClient) => async (req, res, next) => {
  const token = getBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({error: "Missing session token."});
    return;
  }
  const user = await vaultClient.getSessionUser(token);
  if (!user) {
    res.status(401).json({error: "Invalid session token."});
    return;
  }
  req.sessionToken = token;
  req.user = user;
  next();
};

/**
 * Build an Express middleware that enforces a named permission after the
 * request session has been resolved.
 *
 * @param {ReturnType<import("./vaultClient.mjs").createVaultClient>} vaultClient
 * @param {string} permission
 * @returns {import("express").RequestHandler}
 */
export const requirePermission = (vaultClient, permission) => {
  const requireUser = requireSession(vaultClient);
  return async (req, res, next) => {
    await requireUser(req, res, async () => {
      if (!hasPermission(req.user, permission)) {
        res.status(403).json({error: `Missing permission: ${permission}`});
        return;
      }
      next();
    });
  };
};

