"use client";

/**
 * @file Shared loading and empty states for the Moon Next user app.
 */

import {useEffect} from "react";
import {buildMoonLoginHref} from "../lib/api.js";
import {useMoonChrome} from "./MoonChromeContext.jsx";

/**
 * Render a compact loading view.
 *
 * @param {{label?: string}} props
 * @returns {import("react").ReactNode}
 */
export const LoadingView = ({label = ""}) => {
  const {branding} = useMoonChrome();
  const siteName = branding?.siteName || "Scriptarr";
  return (
    <section className="moon-panel moon-state-panel">
      <div className="moon-kicker">Loading</div>
      <h2>Building the reading surface</h2>
      <p>{label || `${siteName} is loading this view.`}</p>
    </section>
  );
};

/**
 * Render a compact error state.
 *
 * @param {{title?: string, detail?: string}} props
 * @returns {import("react").ReactNode}
 */
export const ErrorView = ({title = "", detail = "Refresh the page or try again in a moment."}) => {
  const {branding} = useMoonChrome();
  const siteName = branding?.siteName || "Scriptarr";
  return (
    <section className="moon-panel moon-state-panel moon-state-panel-error">
      <div className="moon-kicker">Error</div>
      <h2>{title || `${siteName} could not finish loading this page.`}</h2>
      <p>{detail}</p>
    </section>
  );
};

/**
 * Defensively redirect routes that need a Moon session.
 *
 * @param {{loginUrl?: string}} props
 * @returns {import("react").ReactNode}
 */
export const AuthRequiredView = ({
  loginUrl = ""
}) => {
  useEffect(() => {
    if (typeof window === "undefined" || window.location.pathname === "/login") {
      return;
    }
    const returnTo = `${window.location.pathname}${window.location.search}`;
    window.location.replace(loginUrl || buildMoonLoginHref(returnTo));
  }, [loginUrl]);

  return (
    <section className="moon-auth-resolving" role="status" aria-live="polite">
      <span>Opening login.</span>
    </section>
  );
};

/**
 * Render a compact empty state.
 *
 * @param {{title: string, detail: string}} props
 * @returns {import("react").ReactNode}
 */
export const EmptyView = ({title, detail}) => (
  <section className="moon-panel moon-state-panel">
    <div className="moon-kicker">Empty</div>
    <h2>{title}</h2>
    <p>{detail}</p>
  </section>
);

export default {
  AuthRequiredView,
  EmptyView,
  ErrorView,
  LoadingView
};
