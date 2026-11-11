/** @file Sage-owned HTTP transport, independent of Node's bundled fetch parser. */
import {fetch as undiciFetch} from "undici";

/** Shared injectable outbound transport; production always uses the pinned client. */
export const sageTransport = {fetch: undiciFetch};

/**
 * Send an outbound request through Sage's explicitly versioned HTTP implementation.
 * @param {RequestInfo | URL} input Destination or request.
 * @param {RequestInit} [options] Fetch options, including cancellation and scoped credentials.
 * @returns {Promise<Response>} Response whose body the caller must consume or cancel.
 */
export const sageFetch = (input, options) => sageTransport.fetch(input, options);
