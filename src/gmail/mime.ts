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

/** Every value of a header that can repeat (Received-SPF, DKIM-Signature, ...), in message order. */
const headerAll = (msg: gmail_v1.Schema$Message, name: string) =>
  (msg.payload?.headers ?? [])
    .filter((h) => h.name?.toLowerCase() === name.toLowerCase() && h.value)
    .map((h) => h.value as string);

/** Sender-authentication evidence, for checking whether a message is what it claims to be. */
export type AuthInfo = {
  /** spf/dkim/dmarc results from Gmail's own Authentication-Results (authserv-id mx.google.com). */
  verdict: { spf?: string; dkim?: string; dmarc?: string };
  /** The d= domain of each DKIM-Signature: the domains that signed the message. */
  dkim_domains: string[];
  return_path?: string;
  reply_to?: string;
  authentication_results: string[];
  received_spf: string[];
  arc_authentication_results: string[];
};

/** Domain of the address in a header like `Name <a@b.com>`; the bracketed address wins over one in the name. */
const domainOf = (value?: string) =>
  (value?.match(/<[^>]*@([\w.-]+)>/) ?? value?.match(/@([\w.-]+)/))?.[1]?.toLowerCase();

/** Crude organizational domain: mail.paypal.com -> paypal.com, a.b.co.uk -> b.co.uk. */
const orgDomain = (domain: string) => {
  const labels = domain.split(".");
  const n = labels.length >= 3 && labels.at(-1)?.length === 2 && (labels.at(-2)?.length ?? 0) <= 3 ? 3 : 2;
  return labels.slice(-n).join(".");
};

/**
 * "ok" or "SUSPICIOUS (<reasons>)" for a received message; undefined for mail with no Gmail stamp
 * (the account's own sent mail). Return-Path is not compared: bulk senders bounce to their
 * provider's domain, so it would flag most newsletters; DMARC alignment covers it.
 */
export const authStatus = (msg: gmail_v1.Schema$Message): string | undefined => {
  const auth = authInfo(msg);
  if (!auth.authentication_results.some((r) => /^\s*mx\.google\.com\s*;/i.test(r))) return undefined;
  const dmarcPass = auth.verdict.dmarc === "pass";
  const problems: string[] = [];
  for (const [method, result] of Object.entries(auth.verdict)) {
    if (result === "pass") continue;
    // A missing SPF or DKIM result is fine when DMARC passed on the other one.
    if ((!result || result === "none" || result === "neutral") && dmarcPass && method !== "dmarc") continue;
    problems.push(`${method}=${result ?? "missing"}`);
  }
  const fromHeader = header(msg, "From") ?? "";
  const from = domainOf(fromHeader);
  if (from && !dmarcPass && !auth.dkim_domains.some((d) => orgDomain(d.toLowerCase()) === orgDomain(from))) {
    problems.push(`no DKIM signature from ${from}`);
  }
  const replyTo = domainOf(auth.reply_to);
  if (from && replyTo && orgDomain(replyTo) !== orgDomain(from)) {
    problems.push(`Reply-To goes to ${replyTo}, not ${from}`);
  }
  // "PayPal security@paypal.com" <x@evil.com>: the display name shows an address that is not the sender.
  const display = fromHeader.includes("<") ? fromHeader.slice(0, fromHeader.indexOf("<")) : "";
  const shown = display.match(/[\w.+-]+@([\w-]+\.[\w.-]+)/)?.[0]?.toLowerCase();
  const actual = fromHeader.match(/<([^>]+)>/)?.[1]?.toLowerCase();
  if (shown && actual && shown !== actual) problems.push(`display name shows ${shown} but sender is ${actual}`);
  return problems.length ? `SUSPICIOUS (${problems.join("; ")})` : "ok";
};

export const authInfo = (msg: gmail_v1.Schema$Message): AuthInfo => {
  const results = headerAll(msg, "Authentication-Results");
  // Only Gmail's own stamp counts: a sender can add any Authentication-Results it likes upstream.
  const gmail = results.find((r) => /^\s*mx\.google\.com\s*;/i.test(r)) ?? "";
  const result = (method: string) => gmail.match(new RegExp(`\\b${method}=(\\w+)`, "i"))?.[1]?.toLowerCase();
  return {
    verdict: { spf: result("spf"), dkim: result("dkim"), dmarc: result("dmarc") },
    dkim_domains: headerAll(msg, "DKIM-Signature")
      .map((sig) => sig.match(/(?:^|;)\s*d=([^;\s]+)/)?.[1])
      .filter((d): d is string => Boolean(d)),
    return_path: header(msg, "Return-Path"),
    reply_to: header(msg, "Reply-To"),
    authentication_results: results,
    received_spf: headerAll(msg, "Received-SPF"),
    arc_authentication_results: headerAll(msg, "ARC-Authentication-Results"),
  };
};

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
