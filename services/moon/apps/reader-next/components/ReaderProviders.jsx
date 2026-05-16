"use client";

/**
 * @file Browser-only providers for the dedicated Moon reader app.
 */

import {useEffect} from "react";

/**
 * Register Moon's existing service worker around the reader app.
 *
 * @param {{children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const ReaderProviders = ({children}) => {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    void navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }, []);

  return children;
};

export default ReaderProviders;
