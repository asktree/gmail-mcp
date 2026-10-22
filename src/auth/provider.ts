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
 *
 * The v2 connector (`/inboxes`) adds one step: between `/authorize` and the
 * code, the user lands on `/inboxes/connect`, signs in as many Gmail
 * accounts as they like, and presses Done. One grant then holds them all.
 */

import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { RequestHandler, Response } from "express";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Google } from "./google.js";
import { Account, type Of, type Sealer } from "./seal.js";

const MINUTE = 60_000;
const ACCESS_TTL = 60 * MINUTE;
/** How long the user has to finish Google sign-in, and Claude to redeem its code. */
const HANDSHAKE_TTL = 10 * MINUTE;
/** The v2 connect page can take several sign-ins, so it gets longer. */
const MULTI_HANDSHAKE_TTL = 30 * MINUTE;

/** The path of the v2 (several inboxes) MCP endpoint. */
export const INBOXES_PATH = "/inboxes";

type Grant = { clientId: string; accounts: z.infer<typeof Account>[]; multi: boolean };

/** What `verifyAccessToken` attaches to `req.auth.extra`: whose mailboxes, and the keys to them. */
export const MailboxGrant = z.object({ accounts: z.array(Account).min(1), multi: z.boolean() });

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

  const start = (client: OAuthClientInformationFull, params: AuthorizationParams, res: Response, multi: boolean) => {
    const state = sealer.seal({
      kind: "pending",
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      multi,
      accounts: [],
      exp: Date.now() + (multi ? MULTI_HANDSHAKE_TTL : HANDSHAKE_TTL),
    });
    res.redirect(multi ? connectUrl(state) : google.authUrl(state));
  };

  const provider: OAuthServerProvider = {
    clientsStore,

    // A client that names `/inboxes` as its resource gets the v2 connect page.
    authorize: async (client, params, res) => start(client, params, res, params.resource?.pathname === INBOXES_PATH),

    challengeForAuthorizationCode: async (client, code) => openCode(client, code).codeChallenge,

    exchangeAuthorizationCode: async (client, code, _verifier, redirectUri) => {
      const { clientId, accounts, multi, ...sealed } = openCode(client, code);
      if (redirectUri && redirectUri !== sealed.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
      return issue({ clientId, accounts, multi });
    },

    exchangeRefreshToken: async (client, refreshToken) => {
      const sealed = sealer.open("refresh", refreshToken);
      if (!sealed || sealed.clientId !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
      // Re-check on every refresh, so removing someone from ALLOWED_EMAILS locks them out within the hour.
      const banned = sealed.accounts.find((a) => !config.isAllowed(a.email));
      if (banned) throw new InvalidGrantError(`${banned.email} is no longer allowed`);
      const { clientId, accounts, multi } = sealed;
      return issue({ clientId, accounts, multi });
    },

    verifyAccessToken: async (token) => {
      const sealed = sealer.open("access", token);
      if (!sealed) throw new InvalidTokenError("Invalid or expired access token");
      return {
        token,
        clientId: sealed.clientId,
        scopes: [],
        expiresAt: Math.floor(sealed.exp / 1000),
        extra: { accounts: sealed.accounts, multi: sealed.multi } satisfies z.infer<typeof MailboxGrant>,
      };
    },
  };

  // ## Google callback
  // Where Google sends the user back. Finish sign-in, then hand Claude a code.

  const openPending = (res: Response, state: unknown) => {
    const pending = sealer.open("pending", String(state ?? ""));
    if (!pending) res.status(400).send("Sign-in link expired or invalid. Start the connection again from Claude.");
    return pending;
  };

  const backToClient = (res: Response, pending: Of<"pending">, params: Record<string, string>) => {
    const url = new URL(pending.redirectUri);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (pending.state) url.searchParams.set("state", pending.state);
    res.redirect(url.href);
  };

  /** Seals the finished grant as an auth code and returns the user to Claude. */
  const finish = (res: Response, pending: Of<"pending">, accounts: Grant["accounts"]) =>
    backToClient(res, pending, {
      code: sealer.seal({
        kind: "code",
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        codeChallenge: pending.codeChallenge,
        accounts,
        multi: pending.multi,
        exp: Date.now() + HANDSHAKE_TTL,
      }),
    });

  const callback: RequestHandler = async (req, res) => {
    const pending = openPending(res, req.query.state);
    if (!pending) return;

    // v1 errors go back to Claude; v2 errors show on the connect page, where the user can try again.
    const fail = (error: string, description: string) =>
      pending.multi
        ? res.redirect(connectUrl(String(req.query.state), description))
        : backToClient(res, pending, { error, error_description: description });

    if (req.query.error || typeof req.query.code !== "string")
      return fail("access_denied", String(req.query.error ?? "No code"));

    try {
      const result = await google.exchange(req.query.code);
      if (!result.ok) return fail("access_denied", result.reason);
      if (!config.isAllowed(result.email))
        return fail("access_denied", `${result.email} is not allowed on this server`);
      const account = { email: result.email, googleRefreshToken: result.refreshToken };
      if (!pending.multi) return finish(res, pending, [account]);

      // Signing in to the same account again replaces it, e.g. to refresh a revoked token.
      const accounts = [...pending.accounts.filter((a) => a.email !== account.email), account];
      res.redirect(connectUrl(sealer.seal({ ...pending, accounts })));
    } catch (err) {
      console.error("Google callback failed", err);
      fail("server_error", "Google sign-in failed");
    }
  };

  // ## v2 connect page
  // Lists the accounts signed in so far. "Add" goes through Google again;
  // "Done" hands Claude one code for all of them. The page holds no data of
  // its own: the sealed `state` in its URL carries the list.

  const connect: RequestHandler = (req, res) => {
    const pending = openPending(res, req.query.state);
    if (!pending) return;
    const state = String(req.query.state);
    const error = typeof req.query.error === "string" ? req.query.error : undefined;
    const done = new URL(`${INBOXES_PATH}/connect/done`, config.baseUrl);
    done.searchParams.set("state", state);
    res.type("html").send(connectPage(pending.accounts, google.authUrl(state), done.href, error));
  };

  const connectDone: RequestHandler = (req, res) => {
    const pending = openPending(res, req.query.state);
    if (!pending) return;
    if (pending.accounts.length === 0)
      return void res.redirect(connectUrl(String(req.query.state), "Add at least one account."));
    finish(res, pending, pending.accounts);
  };

  const connectUrl = (state: string, error?: string) => {
    const url = new URL(`${INBOXES_PATH}/connect`, config.baseUrl);
    url.searchParams.set("state", state);
    if (error) url.searchParams.set("error", error);
    return url.href;
  };

  /** The v2 authorization server (`/inboxes/authorize`): always the connect page, whatever `resource` says. */
  const multiProvider: OAuthServerProvider = {
    ...provider,
    authorize: async (client, params, res) => start(client, params, res, true),
  };

  return { provider, multiProvider, callback, connect, connectDone };
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const connectPage = (accounts: { email: string }[], addUrl: string, doneUrl: string, error?: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Gmail inboxes</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#1d4ed8;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--accent:#93c5fd;--err:#fca5a5}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:28rem;margin:3rem auto;padding:0 16px}
h1{font-size:1.4rem;margin:0 0 .25rem}p{color:var(--muted);margin:0 0 1.5rem}
ul{list-style:none;padding:0;margin:0 0 1.5rem;border-top:1px solid var(--line)}
li{padding:.6rem 0;border-bottom:1px solid var(--line)}
.err{color:var(--err)}
a.btn{display:inline-block;padding:.55rem 1rem;border-radius:8px;text-decoration:none;margin-right:.5rem;border:1px solid var(--line);color:var(--fg)}
a.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
</style></head><body><main>
<h1>Connect Gmail inboxes</h1>
<p>Sign in to each Gmail account this connector should reach, then press Done.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<ul>${accounts.length ? accounts.map((a) => `<li>${escapeHtml(a.email)}</li>`).join("") : "<li>No accounts yet.</li>"}</ul>
<a class="btn${accounts.length ? "" : " primary"}" href="${escapeHtml(addUrl)}">Add a Gmail account</a>
${accounts.length ? `<a class="btn primary" href="${escapeHtml(doneUrl)}">Done</a>` : ""}
</main></body></html>`;
