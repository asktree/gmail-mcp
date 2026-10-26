# gmail-mcp

A remote Gmail [MCP](https://modelcontextprotocol.io) server you host yourself and add to Claude as a **custom connector**. Once it's connected, the connector works everywhere you use Claude: claude.ai, desktop, mobile, and Claude Code.

- **Google sign-in when you connect.** Pick a Gmail account when you add the connector. One deployment can serve several accounts; add one connector per inbox. claude.ai won't add the same URL twice, so give each extra inbox its own path: `/mcp/work`, `/mcp/personal` (lowercase letters, digits and `-`).
- **No database.** Every token is encrypted with your `SECRET` and contains everything the server needs to read it back.
- **Allowlist.** Only the Google accounts in `ALLOWED_EMAILS` can connect (`*` for anyone; each person still reaches only the inboxes they sign in to).

## Tools

| Tool | |
|---|---|
| `search_threads` | Gmail query syntax (`from:`, `is:unread`, `newer_than:7d` …) |
| `get_thread` | Full thread as plain text, with each attachment's `part_id`, name, type and size. Each received message has `auth`: `ok` or `SUSPICIOUS (reasons)`, from Gmail's own SPF/DKIM/DMARC results, DKIM alignment with From, a Reply-To on another domain, and a display name that shows a different address. `include_auth: true` adds the raw evidence as `auth_headers` |
| `get_attachment` | One attachment: images as images, text as text, anything else (PDF …) as an embedded binary resource. Up to 15 MB |
| `list_labels` | |
| `create_draft` / `send_message` | Plain text; pass `reply_to_message_id` to reply in-thread |
| `modify_thread_labels` | Archive, mark read, star, label (names or IDs) |
| `trash_thread` | Recoverable for 30 days |
| `archive_by_query` | Bulk archive: removes INBOX from every inbox message matching a query (skips `exclude_ids` threads). `dry_run` defaults to true |

Scope is `gmail.modify`: read, send, label, trash. It can't permanently delete anything.

## Deploy

### 1. Railway

New project → **Deploy from GitHub repo** → your fork. Then **Settings → Networking → Generate Domain**. Note the domain, e.g. `gmail-mcp-production.up.railway.app`.

Any Node host works. Set `BASE_URL` if you're not on Railway.

### 2. Google OAuth client

In [Google Cloud Console](https://console.cloud.google.com):

1. Create a project and enable the **Gmail API**.
2. **Google Auth Platform → Branding**: fill in an app name and your email.
3. **Audience**: External. Then **Publish app**. If you leave it in *Testing*, Google expires refresh tokens after 7 days and you'll have to reconnect weekly. An unverified app in production works fine for personal use; you'll click through an "unverified app" warning once.
4. **Clients → Create client → Web application**. Add this authorized redirect URI:
   ```
   https://<your-domain>/oauth/google/callback
   ```

### 3. Environment

| Variable | |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From step 2 |
| `SECRET` | `openssl rand -hex 32`. Rotating it signs everyone out. |
| `ALLOWED_EMAILS` | `you@gmail.com,other@gmail.com` |
| `ACCOUNT_NOTES` | Optional. JSON like `{"you@gmail.com": "personal mail"}`. Each note goes into that inbox's server instructions and tool descriptions, so an agent can tell inboxes apart. |
| `SEND_EMAILS` | Optional. Comma list of accounts that may send through `/inboxes`, or `*` for all. Unset means `/inboxes` has no `send_message` tool. `/mcp` is not affected. |
| `NO_SEND_EMAILS` | Optional. Comma list of accounts that never send through `/inboxes`, even with `SEND_EMAILS=*`. |
| `BASE_URL` | Optional on Railway |

### 4. Connect

Go to claude.ai → **Settings → Connectors → Add custom connector**, use `https://<your-domain>/mcp`, then sign in with Google.

### 5. One connector for many inboxes (`/inboxes`)

Use `https://<your-domain>/inboxes` as the connector URL instead. Sign-in opens a connect page. Press **Add a Gmail account** once for each inbox, then press **Done**. Every tool then has an `account` field (required when there are two or more inboxes), so one connector covers all inboxes and the tool list is loaded only once. `send_message` is present only for accounts in `SEND_EMAILS` (and not in `NO_SEND_EMAILS`). Users can also turn the tool off in their claude.ai connector settings. To add an inbox later, reconnect the connector and add all accounts again. `/mcp` (one inbox per connector) still works as before.

## How auth works

```
Claude ──/authorize──▶ server ──▶ Google sign-in ──▶ /oauth/google/callback
       ◀──code──────── server ◀───────────────────────┘
Claude ──/token──────▶ server   (access token wraps the Google refresh token)
Claude ──/mcp────────▶ server ──▶ Gmail API
```

The server acts as an OAuth 2.1 authorization server, with dynamic client registration and PKCE, through the MCP SDK's `mcpAuthRouter`. Google handles the actual sign-in. Client IDs, auth codes, and tokens are AES-256-GCM-encrypted payloads, so nothing is stored on the server.

Trade-offs of storing nothing:

- **No server-side revocation.** To cut off access, remove the email from `ALLOWED_EMAILS` (checked on every hourly token refresh), rotate `SECRET`, or revoke the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- **Auth codes aren't single-use** within their 10-minute window. PKCE still ties each code to the client that requested it.

## Develop

```sh
cp .env.example .env   # add http://localhost:3000/oauth/google/callback to your Google client
pnpm install
pnpm dev
pnpm check             # tsc + biome
```

## License

MIT
