"use client";

/**
 * @file Compact avatar dropdown for Moon's user shell.
 */

import {useEffect, useRef, useState} from "react";
import Link from "next/link";
import {usePathname} from "next/navigation";
import {logoutMoonSession} from "../lib/api.js";
import {buildProfilePath, canAccessAdmin} from "../lib/routes.js";
import {buildAvatarProps} from "../lib/profile.js";
import {Avatar, Button} from "./UiPrimitives.jsx";

/**
 * Render Moon's signed-in avatar menu or the signed-out login action.
 *
 * @param {{
 *   user: {username?: string, role?: string, permissions?: string[], avatarUrl?: string, isOwner?: boolean, adminGrants?: Record<string, string>} | null,
 *   loginUrl: string
 * }} props
 * @returns {import("react").ReactNode}
 */
export const ProfileMenu = ({user, loginUrl}) => {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const rootRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const adminCapable = canAccessAdmin(user);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(/** @type {Node} */ (event.target))) {
        setOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  if (!user) {
    return loginUrl ? (
      <Button href={loginUrl} variant="secondary" size="m">
        Login
      </Button>
    ) : null;
  }

  return (
    <div ref={rootRef} className="moon-profile-menu">
      <button
        className={`moon-avatar-trigger ${open ? "is-open" : ""}`}
        type="button"
        aria-label="Open account menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar
          size="l"
          {...buildAvatarProps(user)}
        />
      </button>
      {open ? (
        <div className="moon-profile-dropdown" role="menu" aria-label="Account menu">
          <Link
            className="moon-profile-dropdown-link"
            href={buildProfilePath()}
            role="menuitem"
            onClick={() => setOpen(false)}
          >
            Profile
          </Link>
          {adminCapable ? (
            <Link
              className="moon-profile-dropdown-link"
              href="/admin"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              Admin
            </Link>
          ) : null}
          <button
            className="moon-profile-dropdown-link moon-profile-dropdown-link-button"
            type="button"
            role="menuitem"
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
        </div>
      ) : null}
    </div>
  );
};

export default ProfileMenu;
