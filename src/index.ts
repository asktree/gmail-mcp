/**
 * # Entrypoint
 *
 * Wires the pieces into one Express app:
 *
 *   /.well-known/*, /authorize, /token, /register   OAuth (SDK router + our provider)
 *   /oauth/google/callback                          Google sign-in lands here
 *   /mcp                                            the MCP endpoint, bearer-protected
 *   /inboxes                                        v2: one endpoint for several inboxes
 *   /inboxes/authorize, /inboxes/connect            v2 sign-in: add accounts, then Done
 */

import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { CALLBACK_PATH, makeGoogle } from "./auth/google.js";
import { INBOXES_PATH, MailboxGrant, makeProvider } from "./auth/provider.js";
import { makeSealer } from "./auth/seal.js";
import { loadConfig } from "./config.js";
import { type Inbox, makeMcpServer } from "./gmail/tools.js";

const config = loadConfig();
const google = makeGoogle(config);
const { provider, multiProvider, callback, connect, connectDone } = makeProvider(
  config,
  google,
  makeSealer(config.secret),
);
const mcpUrl = new URL("/mcp", config.baseUrl);

const app = express();
// Railway (and most hosts) sit behind one proxy; the SDK's rate limiter needs the real client IP.
app.set("trust proxy", 1);
app.use(express.json());

// ## OAuth

app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: config.baseUrl,
    resourceServerUrl: mcpUrl,
    resourceName: "Gmail",
    // Client IDs are sealed and never stored, so there's nothing to expire.
    clientRegistrationOptions: { clientIdGeneration: false, clientSecretExpirySeconds: 0 },
  }),
);
app.get(CALLBACK_PATH, callback);

// ### v2 authorization server
// `/inboxes` names its own issuer, so a client that connects it is sent to
// `/inboxes/authorize` and from there to the connect page. Tokens, clients
// and the Google callback are shared with v1.

const inboxesUrl = new URL(INBOXES_PATH, config.baseUrl);
const inboxesMetadata = {
  ...createOAuthMetadata({ provider: multiProvider, issuerUrl: inboxesUrl, baseUrl: config.baseUrl }),
  authorization_endpoint: new URL(`${INBOXES_PATH}/authorize`, config.baseUrl).href,
};
app.get(
  [
    `/.well-known/oauth-authorization-server${INBOXES_PATH}`,
    `/.well-known/openid-configuration${INBOXES_PATH}`,
    `${INBOXES_PATH}/.well-known/oauth-authorization-server`,
    `${INBOXES_PATH}/.well-known/openid-configuration`,
  ],
  (_req, res) => void res.set("Access-Control-Allow-Origin", "*").json(inboxesMetadata),
);
app.get(`/.well-known/oauth-protected-resource${INBOXES_PATH}`, (_req, res) => {
  res.set("Access-Control-Allow-Origin", "*").json({
    resource: inboxesUrl.href,
    authorization_servers: [inboxesUrl.href],
    resource_name: "Gmail inboxes",
  });
});
app.use(`${INBOXES_PATH}/authorize`, authorizationHandler({ provider: multiProvider }));
app.get(`${INBOXES_PATH}/connect`, connect);
app.get(`${INBOXES_PATH}/connect/done`, connectDone);

// ## MCP
// Stateless: a fresh server + transport per request, bound to the caller's mailbox.
//
// `/mcp/<name>` is the same server under another URL. claude.ai refuses two
// connectors with the same URL, so a second inbox gets e.g. `/mcp/work`.
// Each URL is its own OAuth protected resource, so it gets its own metadata.

const SLOT = /^[a-z0-9-]{1,40}$/;

const slotUrl = (slot?: string) => (slot ? new URL(`/mcp/${slot}`, config.baseUrl) : mcpUrl);
const inboxesAuth = requireBearerAuth({
  verifier: provider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(inboxesUrl),
});

app.get("/.well-known/oauth-protected-resource/mcp/:slot", (req, res) => {
  if (!SLOT.test(req.params.slot)) return void res.status(404).end();
  res.set("Access-Control-Allow-Origin", "*").json({
    resource: slotUrl(req.params.slot).href,
    authorization_servers: [config.baseUrl.href],
    resource_name: "Gmail",
  });
});

/** Checks the bearer token; a 401 points the client at this URL's own metadata. */
const auth: express.RequestHandler<{ slot?: string }> = (req, res, next) => {
  const { slot } = req.params;
  if (slot !== undefined && !SLOT.test(slot)) return void res.status(404).end();
  requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(slotUrl(slot)),
  })(req, res, next);
};

const serveMcp: express.RequestHandler = async (req, res) => {
  const { accounts, multi } = MailboxGrant.parse(req.auth?.extra);
  const inboxes = accounts.map(({ email, googleRefreshToken }) => ({
    email,
    note: config.noteFor(email),
    mailbox: google.mailbox(googleRefreshToken),
    // v1 keeps send for its one account; v2 sends only from SEND_EMAILS.
    canSend: !multi || config.canSend(email),
  })) as [Inbox, ...Inbox[]];
  const server = makeMcpServer(inboxes, multi);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
};

app.post("/mcp", auth, serveMcp);
app.post("/mcp/:slot", auth, serveMcp);
app.post(INBOXES_PATH, inboxesAuth, serveMcp);

// Stateless servers have no SSE stream or session to GET or DELETE.
app.all(["/mcp", "/mcp/:slot", INBOXES_PATH], (_req, res) => {
  res
    .status(405)
    .set("Allow", "POST")
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

app.get("/", (_req, res) => {
  res
    .type("text")
    .send(
      `Gmail MCP server. Add ${inboxesUrl.href} as a custom connector in Claude for several inboxes, or ${mcpUrl.href} for one.`,
    );
});

app.listen(config.port, () => {
  console.log(`gmail-mcp listening on :${config.port}, public URL ${mcpUrl.href}`);
});
