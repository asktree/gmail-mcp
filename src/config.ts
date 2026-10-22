/**
 * # Config
 *
 * Everything the server needs from its environment, parsed once at boot.
 * A bad config should crash loudly at startup, never quietly at request time.
 */

import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3000),

  /** Public origin of this deployment, e.g. `https://gmail-mcp.up.railway.app`. */
  BASE_URL: z.url().optional(),
  /** Railway injects this; used as a fallback when BASE_URL is unset. */
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),

  /** OAuth "Web application" client from Google Cloud Console. */
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),

  /**
   * Key for sealing every token this server hands out. Rotating it signs
   * everyone out (they just reconnect). Generate with `openssl rand -hex 32`.
   */
  SECRET: z.string().min(32, "SECRET must be at least 32 characters"),

  /**
   * Comma-separated Google accounts allowed to connect. `*` allows anyone,
   * which you almost certainly don't want on a public URL.
   */
  ALLOWED_EMAILS: z.string().min(1, "ALLOWED_EMAILS is required (comma-separated, or * for anyone)"),

  /**
   * Comma-separated accounts that may send from the v2 (/inboxes) connector.
   * Unset means no v2 account can send, and v2 has no send_message tool.
   * v1 connectors keep send_message for every account.
   */
  SEND_EMAILS: z.string().default(""),

  /**
   * Optional JSON object of `{"email": "what this inbox is for"}`. The note goes
   * into the server instructions and every tool description, so an agent with
   * several inboxes connected can tell them apart from the tool list alone.
   */
  ACCOUNT_NOTES: z
    .string()
    .optional()
    .transform((s) => (s ? z.record(z.string(), z.string()).parse(JSON.parse(s)) : {})),
});

export type Config = {
  port: number;
  baseUrl: URL;
  google: { clientId: string; clientSecret: string };
  secret: string;
  isAllowed: (email: string) => boolean;
  /** Whether the v2 connector may send from this account (SEND_EMAILS). */
  canSend: (email: string) => boolean;
  /** What an inbox is for, if ACCOUNT_NOTES says. */
  noteFor: (email: string) => string | undefined;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const e = EnvSchema.parse(env);

  const origin =
    e.BASE_URL ??
    (e.RAILWAY_PUBLIC_DOMAIN ? `https://${e.RAILWAY_PUBLIC_DOMAIN}` : undefined) ??
    `http://localhost:${e.PORT}`;

  const notes = new Map(Object.entries(e.ACCOUNT_NOTES).map(([k, v]) => [k.trim().toLowerCase(), v.trim()]));
  const senders = e.SEND_EMAILS.split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const allowed = e.ALLOWED_EMAILS.split(",").map((s) => s.trim().toLowerCase());

  return {
    port: e.PORT,
    baseUrl: new URL(origin),
    google: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET },
    secret: e.SECRET,
    isAllowed: (email) => allowed.includes("*") || allowed.includes(email.toLowerCase()),
    canSend: (email) => senders.includes(email.toLowerCase()),
    noteFor: (email) => notes.get(email.toLowerCase()),
  };
};
