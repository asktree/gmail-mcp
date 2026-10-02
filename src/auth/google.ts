/**
 * # Google
 *
 * The upstream identity provider. When an MCP client (Claude) asks to
 * connect, we bounce the user through Google sign-in; whichever Gmail
 * account they pick is the inbox that connector gets.
 */

import { gmail } from "@googleapis/gmail";
import { OAuth2Client } from "google-auth-library";
import type { Config } from "../config.js";

/** Read, send, label and trash mail. Deliberately not full `mail.google.com` (permanent delete). */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

export const CALLBACK_PATH = "/oauth/google/callback";

export type Google = ReturnType<typeof makeGoogle>;

export const makeGoogle = (config: Config) => {
  const redirectUri = new URL(CALLBACK_PATH, config.baseUrl).href;
  const client = () => new OAuth2Client({ ...config.google, redirectUri });

  // ## Sign-in

  /** `prompt=consent` makes Google always return a refresh token, even on reconnect. */
  const authUrl = (state: string) =>
    client().generateAuthUrl({
      access_type: "offline",
      prompt: "consent select_account",
      scope: [GMAIL_SCOPE],
      state,
    });

  type Exchanged = { ok: true; email: string; refreshToken: string } | { ok: false; reason: string };

  const exchange = async (code: string): Promise<Exchanged> => {
    const { tokens } = await client().getToken(code);
    if (!tokens.refresh_token) return { ok: false, reason: "Google returned no refresh token" };
    if (!tokens.scope?.split(" ").includes(GMAIL_SCOPE))
      return { ok: false, reason: "Gmail access was not granted (the checkbox on Google's consent screen)" };

    const { data } = await mailbox(tokens.refresh_token).users.getProfile({ userId: "me" });
    if (!data.emailAddress) return { ok: false, reason: "Could not read the account's email address" };

    return { ok: true, email: data.emailAddress, refreshToken: tokens.refresh_token };
  };

  // ## API access

  /**
   * One authed Gmail client per refresh token, so Google access tokens get
   * cached and refreshed in memory instead of minted on every tool call.
   */
  const cache = new Map<string, ReturnType<typeof gmail>>();

  const mailbox = (refreshToken: string) => {
    const hit = cache.get(refreshToken);
    if (hit) return hit;
    const auth = client();
    auth.setCredentials({ refresh_token: refreshToken });
    const api = gmail({ version: "v1", auth });
    cache.set(refreshToken, api);
    return api;
  };

  return { authUrl, exchange, mailbox };
};

export type Mailbox = ReturnType<Google["mailbox"]>;
