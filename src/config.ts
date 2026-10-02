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
});

export type Config = {
  port: number;
  baseUrl: URL;
  google: { clientId: string; clientSecret: string };
  secret: string;
  isAllowed: (email: string) => boolean;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const e = EnvSchema.parse(env);

  const origin =
    e.BASE_URL ??
    (e.RAILWAY_PUBLIC_DOMAIN ? `https://${e.RAILWAY_PUBLIC_DOMAIN}` : undefined) ??
    `http://localhost:${e.PORT}`;

  const allowed = e.ALLOWED_EMAILS.split(",").map((s) => s.trim().toLowerCase());

  return {
    port: e.PORT,
    baseUrl: new URL(origin),
    google: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET },
    secret: e.SECRET,
    isAllowed: (email) => allowed.includes("*") || allowed.includes(email.toLowerCase()),
  };
};
