"use client";

/**
 * @file Minimal profile dropdown with a profile link and logout action.
 */

import {useState} from "react";
import Link from "next/link";
import {Avatar, Button, Column, DropdownWrapper} from "@once-ui-system/core";
import {logoutMoonSession} from "../lib/api.js";
import {buildProfilePath} from "../lib/routes.js";
import {buildAvatarProps} from "../lib/profile.js";

/**
 * Render the signed-in user menu or signed-out login action.
 *
 * @param {{
 *   user: {username?: string, role?: string, permissions?: string[], avatarUrl?: string} | null,
 *   loginUrl: string
 * }} props
 * @returns {import("react").ReactNode}
 */
export const ProfileMenu = ({user, loginUrl}) => {
  const [logoutPending, setLogoutPending] = useState(false);

  if (!user) {
    return loginUrl ? (
      <Button href={loginUrl} variant="secondary" size="m">
        Login
      </Button>
    ) : null;
  }

  const dropdown = (
    <Column gap="6" className="moon-profile-dropdown">
      <Link className="moon-profile-dropdown-link" href={buildProfilePath()}>
        Profile
      </Link>
      <button
        className="moon-profile-dropdown-link moon-profile-dropdown-link-button"
        type="button"
        disabled={logoutPending}
        onClick={async () => {
          setLogoutPending(true);
          try {
            await logoutMoonSession();
          } finally {
            window.location.assign("/");
          }
        }}
      >
        {logoutPending ? "Logging out..." : "Logout"}
      </button>
    </Column>
  );

  return (
    <DropdownWrapper
      placement="bottom-end"
      minWidth={180}
      maxWidth={240}
      dropdown={dropdown}
      className="moon-profile-menu"
      trigger={(
        <button className="moon-avatar-trigger" type="button" aria-label="Open account menu">
          <Avatar
            size="l"
            {...buildAvatarProps(user)}
          />
        </button>
      )}
    />
  );
};

export default ProfileMenu;
