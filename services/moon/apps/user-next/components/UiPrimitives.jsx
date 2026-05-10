"use client";

/**
 * @file Lightweight user-app UI primitives that keep Moon's chrome off the
 * broad Once UI component barrel.
 */

import {useCallback, useEffect, useRef, useState} from "react";
import Link from "next/link";

const normalizeGap = (value) => {
  if (value == null || value === false) {
    return undefined;
  }
  const normalized = String(value).trim();
  return /^\d+(\.\d+)?$/.test(normalized) ? `${normalized}px` : normalized;
};

const buttonClassName = ({className = "", variant = "secondary", size = "m"} = {}) =>
  ["moon-ui-button", `is-${variant}`, `is-${size}`, className].filter(Boolean).join(" ");

/**
 * Render a compact Moon button or same-origin link.
 *
 * @param {React.ButtonHTMLAttributes<HTMLButtonElement> & React.AnchorHTMLAttributes<HTMLAnchorElement> & {href?: string, variant?: string, size?: string}} props
 * @returns {import("react").ReactNode}
 */
export const Button = ({children, className = "", href = "", variant = "secondary", size = "m", ...props}) => {
  const resolvedClassName = buttonClassName({className, variant, size});
  if (href) {
    return (
      <Link className={resolvedClassName} href={href} {...props}>
        {children}
      </Link>
    );
  }
  return (
    <button className={resolvedClassName} type={props.type || "button"} {...props}>
      {children}
    </button>
  );
};

/**
 * Render a small flex layout wrapper.
 *
 * @param {React.HTMLAttributes<HTMLDivElement> & {gap?: string | number, vertical?: string, wrap?: boolean}} props
 * @returns {import("react").ReactNode}
 */
export const Flex = ({children, className = "", gap, vertical, wrap = false, style = {}, ...props}) => (
  <div
    className={["moon-ui-flex", className].filter(Boolean).join(" ")}
    style={{
      gap: normalizeGap(gap),
      alignItems: vertical === "center" ? "center" : style.alignItems,
      flexWrap: wrap ? "wrap" : style.flexWrap,
      ...style
    }}
    {...props}
  >
    {children}
  </div>
);

/**
 * Render a small column layout wrapper.
 *
 * @param {React.HTMLAttributes<HTMLDivElement> & {gap?: string | number}} props
 * @returns {import("react").ReactNode}
 */
export const Column = ({children, className = "", gap, style = {}, ...props}) => (
  <div
    className={["moon-ui-column", className].filter(Boolean).join(" ")}
    style={{gap: normalizeGap(gap), ...style}}
    {...props}
  >
    {children}
  </div>
);

/**
 * Render a Discord avatar image or initials fallback.
 *
 * @param {{src?: string, value?: string, size?: "m" | "l" | "xl", className?: string}} props
 * @returns {import("react").ReactNode}
 */
export const Avatar = ({src = "", value = "R", size = "m", className = ""}) => (
  <span className={["moon-ui-avatar", `is-${size}`, className].filter(Boolean).join(" ")}>
    {src ? <img src={src} alt="" referrerPolicy="no-referrer" /> : <span>{value}</span>}
  </span>
);

/**
 * Render a horizontal or vertical overflow scroller.
 *
 * @param {React.HTMLAttributes<HTMLDivElement> & {direction?: "row" | "column", gap?: string | number}} props
 * @returns {import("react").ReactNode}
 */
export const Scroller = ({children, className = "", direction = "row", gap, style = {}, ...props}) => (
  <div
    className={["moon-ui-scroller", direction === "row" ? "is-row" : "is-column", className].filter(Boolean).join(" ")}
    style={{gap: normalizeGap(gap), ...style}}
    {...props}
  >
    {children}
  </div>
);

/**
 * Render a small segmented control from value buttons.
 *
 * @param {{buttons: Array<{label: string, value: string, disabled?: boolean}>, selected: string, onToggle: (value: string) => void, fillWidth?: boolean, compact?: boolean}} props
 * @returns {import("react").ReactNode}
 */
export const SegmentedControl = ({buttons = [], selected = "", onToggle, fillWidth = true, compact = false}) => (
  <div
    className={[
      "moon-ui-segmented",
      fillWidth ? "is-fill" : "",
      compact ? "is-compact" : ""
    ].filter(Boolean).join(" ")}
    role="tablist"
  >
    {buttons.map((button) => (
      <button
        aria-selected={button.value === selected}
        className={button.value === selected ? "is-active" : ""}
        disabled={button.disabled}
        key={button.value}
        role="tab"
        type="button"
        onClick={() => onToggle?.(button.value)}
      >
        {button.label}
      </button>
    ))}
  </div>
);

/**
 * Render a hover/focus reveal card without importing the Once UI popover stack.
 *
 * @param {React.HTMLAttributes<HTMLDivElement> & {trigger: import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const HoverCard = ({children, className = "", trigger, ...props}) => (
  <div className="moon-ui-hover-root">
    {trigger}
    <div className={["moon-ui-hover-card", className].filter(Boolean).join(" ")} {...props}>
      {children}
    </div>
  </div>
);

/**
 * Render a tiny infinite-scroll sentinel around mapped items.
 *
 * @param {{items: unknown[], loading?: boolean, threshold?: number, loadMore: () => Promise<boolean> | boolean, renderItem: (item: any) => import("react").ReactNode}} props
 * @returns {import("react").ReactNode}
 */
export const InfiniteScroll = ({items = [], loading = false, threshold = 0.4, loadMore, renderItem}) => {
  const sentinelRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [pending, setPending] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const requestMore = useCallback(async () => {
    if (pending || loading || !hasMore) {
      return;
    }
    setPending(true);
    try {
      const result = await loadMore?.();
      if (result === false) {
        setHasMore(false);
      }
    } finally {
      setPending(false);
    }
  }, [hasMore, loadMore, loading, pending]);

  useEffect(() => {
    setHasMore(true);
  }, [items.length]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void requestMore();
      }
    }, {threshold});
    observer.observe(node);
    return () => observer.disconnect();
  }, [requestMore, threshold]);

  return (
    <div className="moon-reader-chapter-stack">
      {items.map((item) => renderItem(item))}
      <div ref={sentinelRef} className="moon-ui-infinite-sentinel" aria-hidden="true" />
      {pending ? <div className="moon-reader-empty">Loading next chapter.</div> : null}
    </div>
  );
};

export default {
  Avatar,
  Button,
  Column,
  Flex,
  HoverCard,
  InfiniteScroll,
  Scroller,
  SegmentedControl
};
