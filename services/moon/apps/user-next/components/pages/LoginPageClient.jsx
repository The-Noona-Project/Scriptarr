"use client";

/**
 * @file Dedicated system-wide Moon login page.
 */

import {useEffect, useMemo, useRef, useState} from "react";
import {useRouter} from "next/navigation";
import {Button} from "../UiPrimitives.jsx";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {buildMoonDiscordLoginStartHref, normalizeLoginReturnTo} from "../../lib/loginReturnTo.js";
import {POST_LOGIN_PREP_TIMEOUT_MS, preloadPostLoginUserData} from "../../lib/loginPrep.js";

/**
 * Render Moon's dedicated sign-in front door and bounded post-login prep pass.
 *
 * @param {{returnTo?: string, prepare?: boolean}} props
 * @returns {import("react").ReactNode}
 */
export const LoginPageClient = ({returnTo = "/", prepare = false}) => {
  const router = useRouter();
  const {auth, authError, bootstrapError, branding, loaded} = useMoonChrome();
  const targetPath = useMemo(() => normalizeLoginReturnTo(returnTo), [returnTo]);
  const shouldPrepare = prepare && !(targetPath === "/admin" || targetPath.startsWith("/admin/"));
  const loginHref = useMemo(() => buildMoonDiscordLoginStartHref(targetPath), [targetPath]);
  const redirectedRef = useRef(false);
  const [prepState, setPrepState] = useState(shouldPrepare ? "waiting" : "ready");
  const siteName = branding?.siteName || "Scriptarr";

  useEffect(() => {
    if (!loaded || !auth || redirectedRef.current) {
      return undefined;
    }

    redirectedRef.current = true;
    if (!shouldPrepare) {
      router.replace(targetPath);
      return undefined;
    }

    let active = true;
    let finished = false;
    const finish = () => {
      if (!active || finished) {
        return;
      }
      finished = true;
      setPrepState("done");
      router.replace(targetPath);
    };
    const cap = window.setTimeout(finish, POST_LOGIN_PREP_TIMEOUT_MS + 150);
    setPrepState("preparing");
    void preloadPostLoginUserData({
      returnTo: targetPath,
      user: auth,
      timeoutMs: POST_LOGIN_PREP_TIMEOUT_MS
    }).finally(finish);

    return () => {
      active = false;
      window.clearTimeout(cap);
    };
  }, [auth, loaded, router, shouldPrepare, targetPath]);

  const signedIn = Boolean(auth);
  const preparing = signedIn && shouldPrepare && ["waiting", "preparing"].includes(prepState);
  const sessionDelayed = !signedIn && loaded && Boolean(authError || bootstrapError);

  return (
    <section className="moon-login-page" aria-labelledby="moon-login-title">
      <div className="moon-login-panel">
        <div className="moon-kicker">Account</div>
        <h1 id="moon-login-title">{siteName}</h1>
        {sessionDelayed ? (
          <>
            <p className="moon-login-copy">Session check is delayed. Retrying.</p>
            <div className="moon-login-progress" aria-hidden="true">
              <span />
            </div>
          </>
        ) : signedIn ? (
          <>
            <p className="moon-login-copy">
              {preparing ? "Getting your library ready." : "Opening your library."}
            </p>
            <div className="moon-login-progress" aria-hidden="true">
              <span />
            </div>
            <div className="moon-login-actions">
              <Button href={targetPath} variant="primary" size="l">
                Continue
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="moon-login-copy">Sign in with Discord to open your reader, library, and admin tools.</p>
            <div className="moon-login-actions">
              <a className="moon-ui-button is-primary is-l" href={loginHref}>
                Continue with Discord
              </a>
            </div>
          </>
        )}
      </div>
    </section>
  );
};

export default LoginPageClient;
