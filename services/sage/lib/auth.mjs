const getBearerToken = (header) => {
  if (!header) {
    return "";
  }
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token || "" : "";
};

export const hasPermission = (user, permission) =>
  Boolean(user?.permissions?.includes("admin") || user?.permissions?.includes(permission));

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
