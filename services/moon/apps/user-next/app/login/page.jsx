import LoginPageClient from "../../components/pages/LoginPageClient.jsx";
import {normalizeLoginReturnTo} from "../../lib/loginReturnTo.js";

export const dynamic = "force-dynamic";

/**
 * Render Moon's dedicated login route.
 *
 * @param {{searchParams?: Promise<Record<string, string | string[] | undefined>> | Record<string, string | string[] | undefined>}} props
 * @returns {Promise<import("react").ReactNode>}
 */
export default async function LoginPage({searchParams = {}}) {
  const params = await searchParams;
  const read = (key) => {
    const value = params?.[key];
    return Array.isArray(value) ? value[0] || "" : value || "";
  };
  const returnTo = normalizeLoginReturnTo(read("returnTo"));
  const prepare = read("prepare") === "1" || read("prepare") === "true";
  return <LoginPageClient returnTo={returnTo} prepare={prepare} />;
}
