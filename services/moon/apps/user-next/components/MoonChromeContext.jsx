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
 *   loaded?: boolean,
 *   bootstrap: any,
 *   libraryTypes: Array<{slug: string, label: string, count: number}>,
 *   loginUrl: string,
 *   installAvailable: boolean,
 *   promptInstall: () => Promise<boolean>
 * }>}
 */
const MoonChromeContext = createContext({
  branding: {siteName: "Scriptarr"},
  auth: null,
  loaded: false,
  bootstrap: null,
  libraryTypes: [],
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
 *   loaded?: boolean,
 *   bootstrap: any,
 *   libraryTypes: Array<{slug: string, label: string, count: number}>,
 *   loginUrl: string,
 *   installAvailable: boolean,
 *   promptInstall: () => Promise<boolean>
 * }}
 */
export const useMoonChrome = () => useContext(MoonChromeContext);

export default MoonChromeContext;
