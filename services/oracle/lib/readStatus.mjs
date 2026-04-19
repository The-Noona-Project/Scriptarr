export const readScriptarrStatus = async (config) => {
  try {
    const response = await fetch(`${config.wardenBaseUrl}/api/bootstrap`, {
      signal: AbortSignal.timeout(1200)
    });
    if (!response.ok) {
      throw new Error(`Warden status failed with ${response.status}`);
    }
    const payload = await response.json();
    return {
      ok: true,
      callbackUrl: payload.callbackUrl,
      localAi: payload.localAi,
      services: payload.services
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
};
