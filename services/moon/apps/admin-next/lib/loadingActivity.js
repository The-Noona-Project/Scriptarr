"use client";

/**
 * @file Tiny global loading activity bus for Moon admin.
 */

import {useEffect, useState} from "react";

const LOADING_ACTIVITY_EVENT = "scriptarr:admin-loading-activity";
let loadingSequence = 0;

/**
 * Mark one non-blocking admin load as active until the returned function runs.
 *
 * @param {string} [label]
 * @returns {() => void}
 */
export const beginGlobalLoadingActivity = (label = "Loading admin data.") => {
  if (typeof window === "undefined") {
    return () => {};
  }
  loadingSequence += 1;
  const id = `admin-load-${Date.now()}-${loadingSequence}`;
  window.dispatchEvent(new CustomEvent(LOADING_ACTIVITY_EVENT, {
    detail: {id, active: true, label}
  }));
  let finished = false;
  return () => {
    if (finished) {
      return;
    }
    finished = true;
    window.dispatchEvent(new CustomEvent(LOADING_ACTIVITY_EVENT, {
      detail: {id, active: false}
    }));
  };
};

/**
 * Subscribe to active non-blocking admin loads.
 *
 * @returns {{active: boolean, label: string}}
 */
export const useGlobalLoadingActivity = () => {
  const [activity, setActivity] = useState({active: false, label: "Loading admin data."});

  useEffect(() => {
    const activeLoads = new Map();
    const syncActivity = () => {
      const latest = Array.from(activeLoads.values()).at(-1) || "Loading admin data.";
      setActivity({active: activeLoads.size > 0, label: latest});
    };
    const onActivity = (event) => {
      const id = String(event.detail?.id || "");
      if (!id) {
        return;
      }
      if (event.detail?.active) {
        activeLoads.set(id, String(event.detail?.label || "Loading admin data."));
      } else {
        activeLoads.delete(id);
      }
      syncActivity();
    };
    window.addEventListener(LOADING_ACTIVITY_EVENT, onActivity);
    return () => window.removeEventListener(LOADING_ACTIVITY_EVENT, onActivity);
  }, []);

  return activity;
};
