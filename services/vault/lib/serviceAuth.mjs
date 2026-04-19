const getToken = (header) => {
  if (!header) {
    return "";
  }
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer") {
    return "";
  }
  return token || "";
};

export const serviceAuth = (config) => (req, res, next) => {
  const token = getToken(req.headers.authorization);
  const matched = Object.entries(config.serviceTokens).find(([, expected]) => expected && expected === token);
  if (!matched) {
    res.status(401).json({error: "Unauthorized service token."});
    return;
  }
  req.serviceName = matched[0];
  next();
};
