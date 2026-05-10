"use client";

/**
 * @file Shared browser providers for Moon's Next user app.
 */

import {useEffect} from "react";

/**
 * Mount browser-only user app providers around the Moon shell.
 *
 * @param {{children: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const UserProviders = ({children}) => (
  <UserProvidersShell>{children}</UserProvidersShell>
);

const UserProvidersShell = ({children}) => {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    void navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  }, []);

  return children;
};

export default UserProviders;
