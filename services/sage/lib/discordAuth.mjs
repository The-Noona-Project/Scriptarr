const encode = encodeURIComponent;

export const buildCallbackUrl = (config) =>
  process.env.SCRIPTARR_DISCORD_CALLBACK_URL
  || `${config.publicBaseUrl}/api/moon/auth/discord/callback`;

export const buildDiscordOauthUrl = (config) => {
  const callbackUrl = buildCallbackUrl(config);
  const scopes = encode("identify");
  return `https://discord.com/oauth2/authorize?client_id=${encode(config.discordClientId)}&response_type=code&redirect_uri=${encode(callbackUrl)}&scope=${scopes}`;
};

export const exchangeDiscordCode = async (config, code) => {
  if (!config.discordClientId || !config.discordClientSecret) {
    throw new Error("Discord OAuth is not configured.");
  }

  const callbackUrl = buildCallbackUrl(config);
  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: config.discordClientId,
      client_secret: config.discordClientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl
    })
  });

  if (!tokenResponse.ok) {
    throw new Error(`Discord token exchange failed with status ${tokenResponse.status}.`);
  }

  const tokenPayload = await tokenResponse.json();
  const meResponse = await fetch("https://discord.com/api/users/@me", {
    headers: {
      "Authorization": `Bearer ${tokenPayload.access_token}`
    }
  });

  if (!meResponse.ok) {
    throw new Error(`Discord user lookup failed with status ${meResponse.status}.`);
  }

  const me = await meResponse.json();
  return {
    discordUserId: me.id,
    username: me.global_name || me.username || me.id,
    avatarUrl: me.avatar
      ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png`
      : null
  };
};
