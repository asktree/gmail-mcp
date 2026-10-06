/**
 * # Gmail tools
 *
 * The MCP surface. One server instance is built per request, bound to the
 * mailbox of whoever's access token came in.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Mailbox } from "../auth/google.js";
import { attachmentParts, encodeMessage, header, type Outgoing, parseMessage } from "./mime.js";

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

/** Long newsletters can blow through a context window on their own. */
const MAX_BODY_CHARS = 20_000;

/** Gmail caps attachments at 25 MB; anything near that is too big for one tool result. */
const MAX_ATTACHMENT_BYTES = 15_000_000;

/** Types a model can read as text rather than as a binary blob. */
const isTextual = (mime: string) =>
  mime.startsWith("text/") || ["application/json", "application/xml", "application/csv"].includes(mime);

export const makeMcpServer = (mailbox: Mailbox, email: string) => {
  const server = new McpServer(
    { name: "gmail", version: "1.0.0" },
    {
      instructions: `Gmail for ${email}. Search uses Gmail query syntax (from:, is:unread, newer_than:7d, label:, has:attachment).`,
    },
  );
  const userId = "me";

  // ## Helpers

  /** Lets tools take label names ("Receipts") as well as IDs ("Label_12", "INBOX"). */
  const resolveLabels = async (names: string[]) => {
    if (names.length === 0) return [];
    const { data } = await mailbox.users.labels.list({ userId });
    const labels = data.labels ?? [];
    return names.map((n) => {
      const hit = labels.find((l) => l.id === n || l.name?.toLowerCase() === n.toLowerCase());
      if (!hit?.id) throw new Error(`No label named "${n}"`);
      return hit.id;
    });
  };

  /** Fills in threading headers so a reply lands in the original conversation. */
  const compose = async (args: ComposeArgs): Promise<{ raw: string; threadId?: string }> => {
    const { reply_to_message_id: replyTo, ...m } = args;
    if (!replyTo) {
      if (!m.subject) throw new Error("subject is required when not replying");
      return { raw: encodeMessage({ ...m, subject: m.subject }) };
    }

    const { data: orig } = await mailbox.users.messages.get({
      userId,
      id: replyTo,
      format: "metadata",
      metadataHeaders: ["Message-ID", "References", "Subject"],
    });
    const messageId = header(orig, "Message-ID");
    const subject = header(orig, "Subject") ?? "";
    const outgoing: Outgoing = {
      ...m,
      subject: m.subject ?? (/^re:/i.test(subject) ? subject : `Re: ${subject}`),
      inReplyTo: messageId,
      references: [header(orig, "References"), messageId].filter(Boolean).join(" ") || undefined,
    };
    return { raw: encodeMessage(outgoing), threadId: orig.threadId ?? undefined };
  };

  // ## Reading

  server.registerTool(
    "search_threads",
    {
      description: "Search the mailbox. Returns thread summaries; use get_thread to read one.",
      inputSchema: {
        query: z.string().default("").describe("Gmail search query, e.g. 'from:amy is:unread newer_than:7d'"),
        max_results: z.number().int().min(1).max(50).default(20),
        page_token: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, max_results, page_token }) => {
      const { data } = await mailbox.users.threads.list({
        userId,
        q: query,
        maxResults: max_results,
        pageToken: page_token,
      });
      const threads = await Promise.all(
        (data.threads ?? []).map(async ({ id }) => {
          const { data: t } = await mailbox.users.threads.get({
            userId,
            id: id ?? "",
            format: "metadata",
            metadataHeaders: ["From", "Subject", "Date"],
          });
          const first = t.messages?.[0] ?? {};
          const last = t.messages?.at(-1) ?? {};
          return {
            thread_id: t.id,
            subject: header(first, "Subject"),
            from: header(first, "From"),
            last_date: header(last, "Date"),
            messages: t.messages?.length ?? 0,
            labels: [...new Set(t.messages?.flatMap((m) => m.labelIds ?? []))],
            snippet: last.snippet,
          };
        }),
      );
      return json({ threads, next_page_token: data.nextPageToken });
    },
  );

  server.registerTool(
    "get_thread",
    {
      description: "Read every message in a thread, with bodies as plain text.",
      inputSchema: { thread_id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ thread_id }) => {
      const { data } = await mailbox.users.threads.get({ userId, id: thread_id, format: "full" });
      const messages = (data.messages ?? []).map(parseMessage).map((m) => ({
        ...m,
        body: m.body.length > MAX_BODY_CHARS ? `${m.body.slice(0, MAX_BODY_CHARS)}\n…[truncated]` : m.body,
      }));
      return json({ thread_id, messages });
    },
  );

  server.registerTool(
    "get_attachment",
    {
      description:
        "Download one attachment from a message. get_thread lists each message's attachments with their part_id. " +
        "Images come back as images, text files as text, and other files (PDF, docs, zips) as an embedded binary resource.",
      inputSchema: {
        message_id: z.string(),
        part_id: z.string().optional().describe("From get_thread's attachments list (preferred)"),
        filename: z.string().optional().describe("Used when part_id is not given; first match wins"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ message_id, part_id, filename }) => {
      if (!part_id && !filename) throw new Error("Give part_id or filename");
      const { data: msg } = await mailbox.users.messages.get({ userId, id: message_id, format: "full" });
      const all = attachmentParts(msg);
      const part = all.find((p) => (part_id ? p.partId === part_id : p.filename === filename));
      if (!part) {
        const have = all.map((p) => `${p.partId}: ${p.filename}`).join(", ") || "none";
        throw new Error(`No such attachment on message ${message_id}. Attachments: ${have}`);
      }
      const size = part.body?.size ?? 0;
      if (size > MAX_ATTACHMENT_BYTES)
        throw new Error(`${part.filename} is ${size} bytes; the limit is ${MAX_ATTACHMENT_BYTES}`);

      // Small parts come inline; larger ones need a second call.
      let data = part.body?.data;
      if (!data && part.body?.attachmentId) {
        const { data: att } = await mailbox.users.messages.attachments.get({
          userId,
          messageId: message_id,
          id: part.body.attachmentId,
        });
        data = att.data ?? undefined;
      }
      if (!data) throw new Error(`${part.filename} has no content`);

      const bytes = Buffer.from(data, "base64url");
      const mimeType = part.mimeType ?? "application/octet-stream";
      const meta = {
        type: "text" as const,
        text: JSON.stringify({ filename: part.filename, mime_type: mimeType, size: bytes.length }),
      };

      if (mimeType.startsWith("image/"))
        return { content: [meta, { type: "image" as const, data: bytes.toString("base64"), mimeType }] };
      if (isTextual(mimeType)) {
        const text = bytes.toString("utf8");
        return {
          content: [
            meta,
            {
              type: "text" as const,
              text: text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n…[truncated]` : text,
            },
          ],
        };
      }
      return {
        content: [
          meta,
          {
            type: "resource" as const,
            resource: {
              uri: `gmail://messages/${message_id}/attachments/${part.partId}/${encodeURIComponent(part.filename ?? "")}`,
              mimeType,
              blob: bytes.toString("base64"),
            },
          },
        ],
      };
    },
  );

  server.registerTool(
    "list_labels",
    { description: "List all labels, system and user-created.", annotations: { readOnlyHint: true } },
    async () => {
      const { data } = await mailbox.users.labels.list({ userId });
      return json((data.labels ?? []).map(({ id, name, type }) => ({ id, name, type })));
    },
  );

  // ## Writing

  const composeSchema = {
    to: z.string().describe("Comma-separated recipients"),
    cc: z.string().optional(),
    bcc: z.string().optional(),
    subject: z.string().optional().describe("Required unless replying; replies default to 'Re: <original>'"),
    body: z.string().describe("Plain text body"),
    reply_to_message_id: z.string().optional().describe("Message ID to reply to; keeps the reply in its thread"),
  };
  type ComposeArgs = z.infer<z.ZodObject<typeof composeSchema>>;

  server.registerTool(
    "send_message",
    {
      description: "Send an email immediately. Prefer create_draft unless the user clearly asked to send.",
      inputSchema: composeSchema,
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      const { data } = await mailbox.users.messages.send({ userId, requestBody: await compose(args) });
      return json({ sent: true, message_id: data.id, thread_id: data.threadId });
    },
  );

  server.registerTool(
    "create_draft",
    {
      description: "Save an email as a draft for the user to review and send.",
      inputSchema: composeSchema,
      annotations: { destructiveHint: false },
    },
    async (args) => {
      const { data } = await mailbox.users.drafts.create({ userId, requestBody: { message: await compose(args) } });
      return json({ draft_id: data.id, message_id: data.message?.id, thread_id: data.message?.threadId });
    },
  );

  // ## Organizing

  server.registerTool(
    "modify_thread_labels",
    {
      description:
        "Add or remove labels on a whole thread. Archive = remove INBOX. Mark read = remove UNREAD. Star = add STARRED.",
      inputSchema: {
        thread_id: z.string(),
        add: z.array(z.string()).default([]).describe("Label names or IDs"),
        remove: z.array(z.string()).default([]).describe("Label names or IDs"),
      },
      annotations: { idempotentHint: true },
    },
    async ({ thread_id, add, remove }) => {
      const [addLabelIds, removeLabelIds] = await Promise.all([resolveLabels(add), resolveLabels(remove)]);
      const { data } = await mailbox.users.threads.modify({
        userId,
        id: thread_id,
        requestBody: { addLabelIds, removeLabelIds },
      });
      return json({ thread_id, labels: [...new Set(data.messages?.flatMap((m) => m.labelIds ?? []))] });
    },
  );

  server.registerTool(
    "trash_thread",
    {
      description: "Move a thread to Trash (recoverable for 30 days).",
      inputSchema: { thread_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ thread_id }) => {
      await mailbox.users.threads.trash({ userId, id: thread_id });
      return json({ trashed: thread_id });
    },
  );

  return server;
};
