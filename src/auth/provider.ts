/**
 * # OAuth provider
 *
 * This server is an OAuth 2.1 authorization server in its own right (that's
 * what Claude's custom connectors speak), but it delegates *who you are* to
 * Google. The SDK's `mcpAuthRouter` handles the protocol plumbing (metadata,
 * PKCE checks, client auth); this file supplies the decisions.
 *
 *   Claude ──/authorize──▶ us ──▶ Google sign-in ──▶ /oauth/google/callback
 *          ◀──code──────── us ◀──────────────────────┘
 *   Claude ──/token──────▶ us  (access token wraps the Google refresh token)
 */

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { RequestHandler } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Google } from "./google.js";
import type { Sealer } from "./seal.js";

const MINUTE = 60_000;
const ACCESS_TTL = 60 * MINUTE;
/** How long the user has to finish Google sign-in, and Claude to redeem its code. */
const HANDSHAKE_TTL = 10 * MINUTE;

type Grant = { clientId: string; email: string; googleRefreshToken: string };

/** What `verifyAccessToken` attaches to `req.auth.extra`: whose mailbox, and the key to it. */
export const MailboxGrant = z.object({ email: z.string(), googleRefreshToken: z.string() });

export const makeProvider = (config: Config, google: Google, sealer: Sealer) => {
  // ## Clients
  // Dynamic client registration with no storage: the client ID is the sealed
  // registration itself, so looking a client up is just opening the seal.

  const clientsStore: OAuthRegisteredClientsStore = {
    registerClient: (client) => {
      const clientId = sealer.seal({ kind: "client", client });
      return { ...client, client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000) };
    },
    getClient: (clientId) => {
      const sealed = sealer.open("client", clientId);
      return sealed && ({ ...sealed.client, client_id: clientId } as OAuthClientInformationFull);
    },
  };

  // ## Tokens

  const issue = (grant: Grant): OAuthTokens => ({
    token_type: "Bearer",
    access_token: sealer.seal({ kind: "access", ...grant, exp: Date.now() + ACCESS_TTL }),
    expires_in: ACCESS_TTL / 1000,
    refresh_token: sealer.seal({ kind: "refresh", ...grant }),
  });

  const openCode = (client: OAuthClientInformationFull, code: string) => {
    const sealed = sealer.open("code", code);
    if (!sealed || sealed.clientId !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return sealed;
  };

  // ## Provider

  const provider: OAuthServerProvider = {
    clientsStore,

    authorize: async (client, params, res) => {
      const state = sealer.seal({
        kind: "pending",
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        exp: Date.now() + HANDSHAKE_TTL,
      });
      res.redirect(google.authUrl(state));
    },

    challengeForAuthorizationCode: async (client, code) => openCode(client, code).codeChallenge,

    exchangeAuthorizationCode: async (client, code, _verifier, redirectUri) => {
      const { clientId, email, googleRefreshToken, ...sealed } = openCode(client, code);
      if (redirectUri && redirectUri !== sealed.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
      return issue({ clientId, email, googleRefreshToken });
    },

    exchangeRefreshToken: async (client, refreshToken) => {
      const sealed = sealer.open("refresh", refreshToken);
      if (!sealed || sealed.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
      // Re-check on every refresh, so removing someone from ALLOWED_EMAILS locks them out within the hour.
      if (!config.isAllowed(sealed.email)) throw new InvalidGrantError(`${sealed.email} is no longer allowed`);
      const { clientId, email, googleRefreshToken } = sealed;
      return issue({ clientId, email, googleRefreshToken });
    },

    verifyAccessToken: async (token) => {
      const sealed = sealer.open("access", token);
      if (!sealed) throw new InvalidTokenError("Invalid or expired access token");
      return {
        token,
        clientId: sealed.clientId,
        scopes: [],
        expiresAt: Math.floor(sealed.exp / 1000),
        extra: { email: sealed.email, googleRefreshToken: sealed.googleRefreshToken } satisfies z.infer<
          typeof MailboxGrant
        >,
      };
    },
  };

  // ## Google callback
  // Where Google sends the user back. Finish sign-in, then hand Claude a code.

  const callback: RequestHandler = async (req, res) => {
    const pending = sealer.open("pending", String(req.query.state ?? ""));
    if (!pending) {
      res.status(400).send("Sign-in link expired or invalid. Start the connection again from Claude.");
      return;
    }

    const backToClient = (params: Record<string, string>) => {
      const url = new URL(pending.redirectUri);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      if (pending.state) url.searchParams.set("state", pending.state);
      res.redirect(url.href);
    };
    const deny = (description: string) => backToClient({ error: "access_denied", error_description: description });

    if (req.query.error || typeof req.query.code !== "string") return deny(String(req.query.error ?? "No code"));

    try {
      const result = await google.exchange(req.query.code);
      if (!result.ok) return deny(result.reason);
      if (!config.isAllowed(result.email)) return deny(`${result.email} is not allowed on this server`);

      const code = sealer.seal({
        kind: "code",
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        email: result.email,
        googleRefreshToken: result.refreshToken,
        exp: Date.now() + HANDSHAKE_TTL,
      });
      backToClient({ code });
    } catch (err) {
      console.error("Google callback failed", err);
      backToClient({ error: "server_error", error_description: "Google sign-in failed" });
    }
  };

  return { provider, callback };
};
