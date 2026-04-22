"use client";

/**
 * @file Profile page for Moon's user-next shell.
 */

import {useState} from "react";
import Link from "next/link";
import {Avatar, Button, Column, Flex, StylePanel} from "@once-ui-system/core";
import {useMoonChrome} from "../MoonChromeContext.jsx";
import {AuthRequiredView} from "../StateView.jsx";
import {canAccessAdmin} from "../../lib/routes.js";
import {buildAvatarProps} from "../../lib/profile.js";

/**
 * Render Moon's profile/settings page.
 *
 * @returns {import("react").ReactNode}
 */
export const ProfilePageClient = () => {
  const {auth, installAvailable, loginUrl, promptInstall} = useMoonChrome();
  const [installPending, setInstallPending] = useState(false);

  if (!auth) {
    return (
      <AuthRequiredView
        title="Sign in to manage your Moon profile"
        detail="Profile settings, local theme choices, and app install actions need a signed-in Moon session."
        loginUrl={loginUrl}
      />
    );
  }

  return (
    <div className="moon-page-grid moon-profile-page">
      <section className="moon-panel moon-section moon-profile-summary">
        <div className="moon-kicker">Profile</div>
        <div className="moon-profile-account">
          <Avatar
            className="moon-profile-avatar"
            size="xl"
            {...buildAvatarProps(auth)}
          />
          <Column gap="8">
            <h1 className="moon-profile-heading">{auth.username || "Reader"}</h1>
            <p className="moon-support-copy">
              Moon keeps your reading state, requests, follows, and local reader preferences together in one signed-in surface.
            </p>
            <div className="moon-pill-row">
              <span className="moon-pill">{auth.role || "reader"}</span>
              {Array.isArray(auth.permissions)
                ? auth.permissions.map((permission) => (
                  <span key={permission} className="moon-pill">
                    {permission}
                  </span>
                ))
                : null}
            </div>
          </Column>
        </div>
      </section>

      <section className="moon-panel moon-section">
        <div className="moon-kicker">Settings</div>
        <h2>Personal controls</h2>
        <p className="moon-support-copy">
          These controls stay tied to this browser and this Moon session so each device can keep its own reading vibe.
        </p>
        <div className="moon-profile-grid">
          <div className="moon-profile-card">
            <h3>Style panel</h3>
            <p className="moon-muted">
              Adjust Once UI presentation preferences for this browser without affecting the rest of the server.
            </p>
            <StylePanel />
          </div>

          {installAvailable ? (
            <div className="moon-profile-card">
              <h3>Install app</h3>
              <p className="moon-muted">
                Install Moon as a desktop-style app so the reader feels closer to a dedicated library client.
              </p>
              <Button
                variant="secondary"
                size="m"
                disabled={installPending}
                onClick={async () => {
                  setInstallPending(true);
                  try {
                    await promptInstall();
                  } finally {
                    setInstallPending(false);
                  }
                }}
              >
                {installPending ? "Opening installer..." : "Install app"}
              </Button>
            </div>
          ) : null}

          {canAccessAdmin(auth) ? (
            <div className="moon-profile-card">
              <h3>Admin tools</h3>
              <p className="moon-muted">
                Open the Arr-style admin panel for moderation, metadata repair, source changes, and system settings.
              </p>
              <Button href="/admin" variant="secondary" size="m">
                Open admin
              </Button>
            </div>
          ) : null}

          <div className="moon-profile-card">
            <h3>Reading routes</h3>
            <p className="moon-muted">
              Jump back into the parts of Moon you use most often without digging through the navigation.
            </p>
            <Flex gap="10" wrap>
              <Link className="moon-profile-inline-link" href="/library">Library</Link>
              <Link className="moon-profile-inline-link" href="/myrequests">Requests</Link>
              <Link className="moon-profile-inline-link" href="/following">Following</Link>
            </Flex>
          </div>
        </div>
      </section>
    </div>
  );
};

export default ProfilePageClient;
