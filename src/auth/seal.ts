/**
 * # Sealed tokens
 *
 * This server keeps no database. Every credential it issues (client IDs,
 * auth codes, access and refresh tokens, the Google `state` param) is a
 * typed payload encrypted with AES-256-GCM under `SECRET`. The server can
 * read its own tokens back; nobody else can read or forge them.
 *
 * The `kind` tag stops one sort of token being passed off as another,
 * e.g. presenting a client ID as an access token.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";

// ## Payloads

const Expiring = { exp: z.number() };

const Grant = {
  clientId: z.string(),
  email: z.string(),
  googleRefreshToken: z.string(),
};

export const Sealed = z.discriminatedUnion("kind", [
  /** A dynamically registered OAuth client; the whole record *is* the client ID. */
  z.object({ kind: z.literal("client"), client: z.record(z.string(), z.unknown()) }),

  /** Round-trips through Google as `state` while the user signs in. */
  z.object({
    kind: z.literal("pending"),
    clientId: z.string(),
    redirectUri: z.string(),
    codeChallenge: z.string(),
    state: z.string().optional(),
    ...Expiring,
  }),

  /** Authorization code handed back to the MCP client. */
  z.object({
    kind: z.literal("code"),
    redirectUri: z.string(),
    codeChallenge: z.string(),
    ...Grant,
    ...Expiring,
  }),

  z.object({ kind: z.literal("access"), ...Grant, ...Expiring }),
  z.object({ kind: z.literal("refresh"), ...Grant }),
]);

export type Sealed = z.infer<typeof Sealed>;
export type Kind = Sealed["kind"];
export type Of<K extends Kind> = Extract<Sealed, { kind: K }>;

// ## Crypto

const IV_BYTES = 12;
const TAG_BYTES = 16;

export type Sealer = {
  seal: (payload: Sealed) => string;
  /** Returns undefined for anything forged, garbled, expired, or of the wrong kind. */
  open: <K extends Kind>(kind: K, token: string) => Of<K> | undefined;
};

export const makeSealer = (secret: string): Sealer => {
  const key = createHash("sha256").update(secret).digest();

  const seal = (payload: Sealed) => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  };

  const decrypt = (token: string): unknown => {
    try {
      const raw = Buffer.from(token, "base64url");
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const body = Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
      return JSON.parse(body.toString("utf8"));
    } catch {
      return undefined;
    }
  };

  const open = <K extends Kind>(kind: K, token: string): Of<K> | undefined => {
    const parsed = Sealed.safeParse(decrypt(token));
    if (!parsed.success || parsed.data.kind !== kind) return undefined;
    if ("exp" in parsed.data && parsed.data.exp < Date.now()) return undefined;
    return parsed.data as Of<K>;
  };

  return { seal, open };
};
