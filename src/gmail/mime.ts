/**
 * # MIME
 *
 * Gmail speaks raw RFC 2822 in base64url. This file translates between that
 * and the plain shapes the tools hand to the model.
 */

import type { gmail_v1 } from "@googleapis/gmail";

// ## Reading

export type Message = {
  id: string;
  threadId: string;
  labels: string[];
  from: string;
  to: string;
  cc?: string;
  date: string;
  subject: string;
  body: string;
  attachments: Attachment[];
};

/** What a model needs to pick an attachment and fetch it with get_attachment. */
export type Attachment = { part_id: string; filename: string; mime_type: string; size: number };

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

export const header = (msg: gmail_v1.Schema$Message, name: string) =>
  msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;

/** Depth-first walk over a message's MIME tree. */
const parts = function* (part: gmail_v1.Schema$MessagePart | undefined): Generator<gmail_v1.Schema$MessagePart> {
  if (!part) return;
  yield part;
  for (const child of part.parts ?? []) yield* parts(child);
};

/** Crude, but models read the result fine and it costs no dependency. */
const htmlToText = (html: string) =>
  html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Prefer text/plain; fall back to stripped HTML. */
const bodyOf = (msg: gmail_v1.Schema$Message) => {
  const all = [...parts(msg.payload)];
  const find = (mime: string) => all.find((p) => p.mimeType === mime && p.body?.data && !p.filename)?.body?.data;
  const plain = find("text/plain");
  if (plain) return decode(plain).trim();
  const html = find("text/html");
  return html ? htmlToText(decode(html)) : "";
};

export const parseMessage = (msg: gmail_v1.Schema$Message): Message => ({
  id: msg.id ?? "",
  threadId: msg.threadId ?? "",
  labels: msg.labelIds ?? [],
  from: header(msg, "From") ?? "",
  to: header(msg, "To") ?? "",
  cc: header(msg, "Cc"),
  date: header(msg, "Date") ?? "",
  subject: header(msg, "Subject") ?? "",
  body: bodyOf(msg),
  attachments: attachmentParts(msg).map((p) => ({
    part_id: p.partId ?? "",
    filename: p.filename ?? "",
    mime_type: p.mimeType ?? "application/octet-stream",
    size: p.body?.size ?? 0,
  })),
});

/** Parts with a filename are attachments (inline images included). */
export const attachmentParts = (msg: gmail_v1.Schema$Message) => [...parts(msg.payload)].filter((p) => p.filename);

// ## Writing

export type Outgoing = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  /** Threading headers, set when replying. */
  inReplyTo?: string;
  references?: string;
};

/** RFC 2047 encoded-word, so non-ASCII subjects survive. */
const encodeWord = (s: string) =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

export const encodeMessage = (m: Outgoing) => {
  const headers = [
    ["To", m.to],
    ["Cc", m.cc],
    ["Bcc", m.bcc],
    ["Subject", encodeWord(m.subject)],
    ["In-Reply-To", m.inReplyTo],
    ["References", m.references],
    ["MIME-Version", "1.0"],
    ["Content-Type", 'text/plain; charset="UTF-8"'],
    ["Content-Transfer-Encoding", "base64"],
  ].flatMap(([k, v]) => (v ? [`${k}: ${v}`] : []));

  const body = Buffer.from(m.body, "utf8").toString("base64");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`).toString("base64url");
};
