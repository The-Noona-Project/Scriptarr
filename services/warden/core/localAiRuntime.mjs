import {
  DEFAULT_LOCALAI_CONTAINER_NAME,
  DEFAULT_LOCALAI_PORT
} from "../config/constants.mjs";
import {localAiProfiles, resolveLocalAiProfile} from "../config/localAiProfiles.mjs";
import {ensureDockerNetwork, imageExists, removeDockerContainer, runDetachedContainer, runDocker, containerExists} from "../docker/dockerCli.mjs";

/**
 * Create the mutable LocalAI runtime used by Warden's API routes.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   logger: {info: Function, warn: Function, error: Function}
 * }} options
 * @returns {{
 *   configure: (payload?: {profileKey?: string, imageMode?: string, customImage?: string}) => Promise<Record<string, unknown>>,
 *   getStatus: () => Record<string, unknown>,
 *   refreshStatus: () => Promise<Record<string, unknown>>,
 *   install: () => Promise<Record<string, unknown>>,
 *   start: () => Promise<Record<string, unknown>>
 * }}
 */
export const createLocalAiRuntime = ({env = process.env, logger}) => {
  const containerName = env.SCRIPTARR_LOCALAI_CONTAINER_NAME || DEFAULT_LOCALAI_CONTAINER_NAME;
  const publishedPort = Number.parseInt(env.SCRIPTARR_LOCALAI_PORT || String(DEFAULT_LOCALAI_PORT), 10) || DEFAULT_LOCALAI_PORT;
  const managedNetworkName = env.SCRIPTARR_NETWORK_NAME || "scriptarr-network";
  const detectedProfile = resolveLocalAiProfile({env});

  const state = {
    configuredProfileKey: detectedProfile.key,
    configuredImageMode: "preset",
    configuredCustomImage: "",
    installOnFirstBoot: false,
    installed: false,
    running: false,
    phase: "idle",
    message: "LocalAI is optional and not installed on first boot.",
    lastError: null,
    updatedAt: new Date().toISOString()
  };

  const mark = (updates) => {
    Object.assign(state, updates, {updatedAt: new Date().toISOString()});
  };

  const configuredProfile = () => localAiProfiles[state.configuredProfileKey] || detectedProfile;

  const currentImage = () =>
    state.configuredImageMode === "custom" && state.configuredCustomImage
      ? state.configuredCustomImage
      : configuredProfile().image;

  const getStatus = () => ({
    ...state,
    detectedProfile,
    configuredProfile: configuredProfile(),
    configuredImage: currentImage(),
    profiles: Object.values(localAiProfiles),
    containerName,
    managedNetworkName,
    publishedPort
  });

  const refreshStatus = async () => {
    mark({
      running: await containerExists(containerName),
      installed: await imageExists(currentImage())
    });
    return getStatus();
  };

  const configure = async ({profileKey, imageMode, customImage} = {}) => {
    const nextProfileKey = localAiProfiles[profileKey] ? profileKey : state.configuredProfileKey;
    const nextImageMode = imageMode === "custom" ? "custom" : "preset";
    const nextCustomImage = nextImageMode === "custom" ? String(customImage || "").trim() : "";

    mark({
      configuredProfileKey: nextProfileKey,
      configuredImageMode: nextImageMode,
      configuredCustomImage: nextCustomImage,
      message: "LocalAI selection updated. Install and start remain manual.",
      lastError: null
    });

    logger.info("Updated LocalAI selection.", {
      profile: state.configuredProfileKey,
      mode: state.configuredImageMode,
      image: currentImage()
    });

    return getStatus();
  };

  const install = async () => {
    if (state.phase !== "idle") {
      return getStatus();
    }

    const image = currentImage();
    mark({
      phase: "installing",
      message: "Pulling the selected LocalAI image. This can take a long time.",
      lastError: null
    });

    try {
      await runDocker(["pull", image], {stdio: "inherit"});
      mark({
        installed: true,
        phase: "idle",
        message: "LocalAI image pulled successfully."
      });
      logger.info("Installed LocalAI image.", {image});
    } catch (error) {
      mark({
        installed: false,
        phase: "idle",
        lastError: error instanceof Error ? error.message : String(error),
        message: "LocalAI image pull failed."
      });
      logger.error("LocalAI image pull failed.", {image, error: state.lastError});
    }

    return getStatus();
  };

  const start = async () => {
    if (state.phase !== "idle") {
      return getStatus();
    }

    const image = currentImage();
    mark({
      phase: "starting",
      message: "Starting LocalAI. Initial startup can take 5 to 20 minutes depending on the host.",
      lastError: null
    });

    try {
      await ensureDockerNetwork(managedNetworkName);
      await removeDockerContainer(containerName);
      await runDetachedContainer({
        name: containerName,
        image,
        env: {},
        networkName: managedNetworkName,
        networkAliases: ["scriptarr-localai"],
        publishedPorts: [{hostPort: publishedPort, containerPort: DEFAULT_LOCALAI_PORT}]
      });
      mark({
        installed: true,
        running: true,
        phase: "idle",
        message: "LocalAI container started."
      });
      logger.info("Started LocalAI container.", {
        image,
        network: managedNetworkName,
        publishedPort
      });
    } catch (error) {
      mark({
        running: false,
        phase: "idle",
        lastError: error instanceof Error ? error.message : String(error),
        message: "LocalAI container failed to start."
      });
      logger.error("LocalAI container failed to start.", {
        image,
        error: state.lastError
      });
    }

    return getStatus();
  };

  return {
    configure,
    getStatus,
    refreshStatus,
    install,
    start
  };
};
