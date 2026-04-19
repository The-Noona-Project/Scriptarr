import {DEFAULT_IMAGE_NAMESPACE, DEFAULT_IMAGE_TAG} from "./constants.mjs";

const normalizeString = (value) => String(value ?? "").trim();

/**
 * Resolve the Docker namespace used for Scriptarr first-party images.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
export const resolveImageNamespace = ({env = process.env} = {}) =>
  normalizeString(env.SCRIPTARR_IMAGE_NAMESPACE || DEFAULT_IMAGE_NAMESPACE).replace(/\/+$/, "");

/**
 * Resolve the Docker image tag used for Scriptarr first-party images.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
export const resolveImageTag = ({env = process.env} = {}) =>
  normalizeString(env.SCRIPTARR_IMAGE_TAG || DEFAULT_IMAGE_TAG) || DEFAULT_IMAGE_TAG;

/**
 * Resolve a fully-qualified first-party image reference.
 *
 * @param {string} serviceName
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {string}
 */
export const resolveServiceImage = (serviceName, {env = process.env} = {}) =>
  `${resolveImageNamespace({env})}/${serviceName}:${resolveImageTag({env})}`;
