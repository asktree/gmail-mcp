/**
 * # Entrypoint
 *
 * Wires the pieces into one Express app:
 *
 *   /.well-known/*, /authorize, /token, /register   OAuth (SDK router + our provider)
 *   /oauth/google/callback                          Google sign-in lands here
 *   /mcp                                            the MCP endpoint, bearer-protected
 */

import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { CALLBACK_PATH, makeGoogle } from "./auth/google.js";
import { MailboxGrant, makeProvider } from "./auth/provider.js";
import { makeSealer } from "./auth/seal.js";
import { loadConfig } from "./config.js";
import { makeMcpServer } from "./gmail/tools.js";

const config = loadConfig();
const google = makeGoogle(config);
const { provider, callback } = makeProvider(config, google, makeSealer(config.secret));
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

// ## MCP
// Stateless: a fresh server + transport per request, bound to the caller's mailbox.
//
// `/mcp/<name>` is the same server under another URL. claude.ai refuses two
// connectors with the same URL, so a second inbox gets e.g. `/mcp/work`.
// Each URL is its own OAuth protected resource, so it gets its own metadata.

const SLOT = /^[a-z0-9-]{1,40}$/;

const slotUrl = (slot?: string) => (slot ? new URL(`/mcp/${slot}`, config.baseUrl) : mcpUrl);

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
  const { email, googleRefreshToken } = MailboxGrant.parse(req.auth?.extra);
  const server = makeMcpServer(google.mailbox(googleRefreshToken), email);
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

// Stateless servers have no SSE stream or session to GET or DELETE.
app.all(["/mcp", "/mcp/:slot"], (_req, res) => {
  res
    .status(405)
    .set("Allow", "POST")
    .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

app.get("/", (_req, res) => {
  res.type("text").send(`Gmail MCP server. Add ${mcpUrl.href} as a custom connector in Claude.`);
});

app.listen(config.port, () => {
  console.log(`gmail-mcp listening on :${config.port}, public URL ${mcpUrl.href}`);
});
