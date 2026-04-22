/**
 * @file Shared loading and empty states for the Moon Next user app.
 */

import {Button} from "@once-ui-system/core";

/**
 * Render a compact loading view.
 *
 * @param {{label?: string}} props
 * @returns {import("react").ReactNode}
 */
export const LoadingView = ({label = "Moon is loading this view."}) => (
  <section className="moon-panel moon-state-panel">
    <div className="moon-kicker">Loading</div>
    <h2>Building the reading surface</h2>
    <p>{label}</p>
  </section>
);

/**
 * Render a compact error state.
 *
 * @param {{title?: string, detail?: string}} props
 * @returns {import("react").ReactNode}
 */
export const ErrorView = ({title = "Moon could not finish loading this page.", detail = "Refresh the page or try again in a moment."}) => (
  <section className="moon-panel moon-state-panel moon-state-panel-error">
    <div className="moon-kicker">Error</div>
    <h2>{title}</h2>
    <p>{detail}</p>
  </section>
);

/**
 * Render a signed-out state for routes that need a Moon session.
 *
 * @param {{title?: string, detail?: string, loginUrl?: string}} props
 * @returns {import("react").ReactNode}
 */
export const AuthRequiredView = ({
  title = "Sign in to keep reading",
  detail = "Use Discord login to open your library, requests, follows, and full reader progress.",
  loginUrl = ""
}) => (
  <section className="moon-panel moon-state-panel">
    <div className="moon-kicker">Account</div>
    <h2>{title}</h2>
    <p>{detail}</p>
    {loginUrl ? (
      <div style={{marginTop: "16px"}}>
        <Button href={loginUrl} variant="primary" size="m">
          Continue with Discord
        </Button>
      </div>
    ) : null}
  </section>
);

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
