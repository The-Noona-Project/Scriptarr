export const readScriptarrStatus = async (sageClient) => {
  try {
    const payload = await sageClient.getBootstrapStatus();
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
