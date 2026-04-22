"use client";

/**
 * @file Shared Moon user-shell chrome context for the Next app.
 */

import {createContext, useContext} from "react";

/**
 * Shared shell payload loaded once by MoonShell and consumed by page clients.
 *
 * @type {import("react").Context<{
 *   branding: {siteName?: string},
 *   auth: any,
 *   bootstrap: any,
 *   loginUrl: string,
 *   installAvailable: boolean,
 *   promptInstall: () => Promise<boolean>
 * }>}
 */
const MoonChromeContext = createContext({
  branding: {siteName: "Scriptarr"},
  auth: null,
  bootstrap: null,
  loginUrl: "",
  installAvailable: false,
  promptInstall: async () => false
});

/**
 * Read the current Moon shell chrome context.
 *
 * @returns {{
 *   branding: {siteName?: string},
 *   auth: any,
 *   bootstrap: any,
 *   loginUrl: string,
 *   installAvailable: boolean,
 *   promptInstall: () => Promise<boolean>
 * }}
 */
export const useMoonChrome = () => useContext(MoonChromeContext);

export default MoonChromeContext;
