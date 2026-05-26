"use client";

/**
 * @file Tiny global loading activity bus for the dedicated reader app.
 */

import {useEffect, useState} from "react";

const LOADING_ACTIVITY_EVENT = "scriptarr:reader-loading-activity";
let loadingSequence = 0;

/**
 * Mark one non-blocking reader metadata load active until the returned function runs.
 *
 * @param {string} [label]
 * @returns {() => void}
 */
export const beginGlobalLoadingActivity = (label = "Loading reader state.") => {
  if (typeof window === "undefined") {
    return () => {};
  }
  loadingSequence += 1;
  const id = `reader-load-${Date.now()}-${loadingSequence}`;
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
 * Subscribe to active non-blocking reader metadata loads.
 *
 * @returns {{active: boolean, label: string}}
 */
export const useGlobalLoadingActivity = () => {
  const [activity, setActivity] = useState({active: false, label: "Loading reader state."});

  useEffect(() => {
    const activeLoads = new Map();
    const syncActivity = () => {
      const latest = Array.from(activeLoads.values()).at(-1) || "Loading reader state.";
      setActivity({active: activeLoads.size > 0, label: latest});
    };
    const onActivity = (event) => {
      const id = String(event.detail?.id || "");
      if (!id) {
        return;
      }
      if (event.detail?.active) {
        activeLoads.set(id, String(event.detail?.label || "Loading reader state."));
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
