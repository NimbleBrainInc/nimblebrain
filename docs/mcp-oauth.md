# MCP OAuth — External Client Authentication

NimbleBrain exposes itself as an MCP server via the `/mcp` Streamable HTTP endpoint. External MCP clients (Claude Desktop, Cursor, VS Code, etc.) can connect to it and access all installed tools through the standard MCP protocol.

Authentication is handled via **WorkOS AuthKit**, which acts as an OAuth 2.0 authorization server. MCP clients discover AuthKit automatically through standard OAuth metadata endpoints — no API keys needed.

## How It Works

```
MCP Client                    NimbleBrain                     WorkOS AuthKit
──────────                    ───────────                     ──────────────
POST /mcp (no token) ──────►
                     ◄────── 401 + WWW-Authenticate header
                              (includes resource_metadata URL)

GET /.well-known/
  oauth-protected-resource ►
                     ◄────── { authorization_servers: [authkit] }

                              ──── OAuth code flow (PKCE) ──► authkit.app
                              ◄──── access_token (JWT) ──────

POST /mcp + Bearer JWT ────►
                              verify JWT via AuthKit JWKS
                              resolve user + workspace
                              execute tools
                     ◄────── JSON-RPC response
```

1. Client hits `/mcp` without a token, gets a `401` with a `WWW-Authenticate` header
2. Client fetches `/.well-known/oauth-protected-resource` to discover AuthKit
3. Client runs the OAuth authorization code flow with PKCE against AuthKit
4. User authenticates in the browser (via AuthKit or your custom login page)
5. Client receives a JWT access token signed by AuthKit
6. Client sends subsequent `/mcp` requests with `Authorization: Bearer <jwt>`
7. NimbleBrain verifies the JWT against AuthKit's JWKS and resolves the user

## Configuration

### 1. Add `authkitDomain` to instance.json

Add the `authkitDomain` field to your WorkOS auth config in `~/.nimblebrain/instance.json`:

```json
{
  "auth": {
    "adapter": "workos",
    "clientId": "client_...",
    "redirectUri": "http://localhost:27246/v1/auth/callback",
    "organizationId": "org_...",
    "authkitDomain": "your-subdomain"
  },
  "orgName": "Your Org"
}
```

The `authkitDomain` value is the subdomain of your AuthKit instance. For example, if your AuthKit URL is `https://nimblebrain.authkit.app`, the value is `"nimblebrain"`.

### 2. Enable CIMD in WorkOS Dashboard

In the WorkOS Dashboard, go to **Connect > Configuration** and enable **Client ID Metadata Document (CIMD)**. This allows MCP clients to self-identify without prior registration — required for zero-config client discovery.

Optionally enable **Dynamic Client Registration (DCR)** for backward compatibility with older MCP clients that don't support CIMD.

### 3. Configure MCP Client

Point your MCP client at the NimbleBrain `/mcp` endpoint. See [Client Setup](#client-setup) below for detailed instructions per client.

## Client Setup

### Claude Code

Claude Code natively supports RFC 9728 and RFC 8414 OAuth discovery. When it connects and receives a 401, it automatically fetches `/.well-known/oauth-protected-resource`, discovers AuthKit, and opens a browser for authentication.

**Via CLI:**
```bash
claude mcp add --transport http nimblebrain http://localhost:27247/mcp
```

**Via `.mcp.json`** (project-scoped):
```json
{
  "mcpServers": {
    "nimblebrain": {
      "type": "http",
      "url": "http://localhost:27247/mcp",
      "headers": {
        "X-Workspace-Id": "ws_your_workspace_id"
      }
    }
  }
}
```

The `X-Workspace-Id` header is optional if the user belongs to exactly one workspace.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "nimblebrain": {
      "type": "http",
      "url": "http://localhost:27247/mcp",
      "headers": {
        "X-Workspace-Id": "ws_your_workspace_id"
      }
    }
  }
}
```

Claude Desktop supports Streamable HTTP transport and OAuth-based MCP servers. It will handle the RFC 9728/8414 discovery flow and open a browser for authentication.

### Cursor

Cursor supports MCP servers through its settings UI:

1. Open **Cursor Settings > MCP > Add Server**
2. Choose the HTTP/URL-based server type
3. Set the URL to `http://localhost:27247/mcp`

Cursor supports OAuth-based MCP servers. Check [Cursor's MCP documentation](https://docs.cursor.com/context/model-context-protocol) for the latest configuration details.

### OpenAI Codex CLI

Codex CLI supports MCP servers via its configuration file. Note that Codex may not fully support RFC 9728 OAuth discovery yet — you may need to obtain a token manually and configure it as a bearer token. Check [Codex CLI's documentation](https://github.com/openai/codex) for the latest MCP authentication support.

### Generic MCP Client

Any client that supports Streamable HTTP transport can connect to NimbleBrain's `/mcp` endpoint.

**Automatic OAuth discovery (recommended):**

Clients that support [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) (Protected Resource Metadata) or [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) (Authorization Server Metadata) will discover AuthKit automatically from the 401 response.

**Manual setup:**

1. Fetch `GET /.well-known/oauth-protected-resource` to find the AuthKit authorization server URL
2. Fetch `GET /.well-known/oauth-authorization-server` to get OAuth endpoints (authorize, token, JWKS)
3. Implement the OAuth 2.0 authorization code flow with PKCE against AuthKit
4. Include the access token as `Authorization: Bearer <jwt>` on all `/mcp` requests
5. Include `X-Workspace-Id: ws_...` header for multi-workspace users (omit if the user has exactly one workspace)

## Workspace ID

NimbleBrain is multi-tenant — every MCP request must be scoped to a workspace. External MCP clients specify this via the `X-Workspace-Id` header.

**Finding your workspace ID:**

- **Web UI:** Go to **Settings > Profile**. The "MCP Connection" card at the bottom shows your active workspace ID with a copy button.

If the user belongs to exactly one workspace, the server will resolve it automatically and the header can be omitted.

## Discovery Endpoints

These endpoints are unauthenticated and served by NimbleBrain for MCP client discovery:

### `GET /.well-known/oauth-protected-resource`

[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) Protected Resource Metadata. Tells MCP clients which authorization server to use.

```json
{
  "resource": "http://localhost:27247",
  "authorization_servers": ["https://your-subdomain.authkit.app"],
  "bearer_methods_supported": ["header"]
}
```

### `GET /.well-known/oauth-authorization-server`

[RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) Authorization Server Metadata. Proxied from AuthKit for backward compatibility with older MCP clients.

```json
{
  "issuer": "https://your-subdomain.authkit.app",
  "authorization_endpoint": "https://your-subdomain.authkit.app/oauth2/authorize",
  "token_endpoint": "https://your-subdomain.authkit.app/oauth2/token",
  "jwks_uri": "https://your-subdomain.authkit.app/oauth2/jwks",
  "registration_endpoint": "https://your-subdomain.authkit.app/oauth2/register",
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "response_types_supported": ["code"],
  "scopes_supported": ["email", "offline_access", "openid", "profile"],
  "code_challenge_methods_supported": ["S256"]
}
```

## Local Development Setup

You can test MCP OAuth entirely on localhost. Here's the step-by-step setup:

### Prerequisites

- A WorkOS account with an AuthKit instance configured
- Your AuthKit subdomain (e.g., `nimblebrain` from `nimblebrain.authkit.app`)
- CIMD enabled in the WorkOS Dashboard (Connect > Configuration)

### Step 1: Configure instance.json

Edit `~/.nimblebrain/instance.json`:

```json
{
  "auth": {
    "adapter": "workos",
    "clientId": "client_YOUR_CLIENT_ID",
    "redirectUri": "http://localhost:27246/v1/auth/callback",
    "organizationId": "org_YOUR_ORG_ID",
    "authkitDomain": "your-subdomain"
  },
  "orgName": "Your Org"
}
```

### Step 2: Start NimbleBrain

```bash
bun run dev
```

This starts the API on port 27247 and the web client on port 27246.

### Step 3: Verify discovery endpoints

```bash
# Should return your AuthKit domain as the authorization server
curl -s http://localhost:27247/.well-known/oauth-protected-resource | jq .

# Should proxy AuthKit's OAuth metadata
curl -s http://localhost:27247/.well-known/oauth-authorization-server | jq .

# Should return 401 with WWW-Authenticate header
curl -sv http://localhost:27247/mcp 2>&1 | grep -i www-authenticate
```

Expected `WWW-Authenticate` header:
```
Bearer error="unauthorized", error_description="Authorization required", resource_metadata="http://localhost:27247/.well-known/oauth-protected-resource"
```

### Step 4: Find your workspace ID

Open `http://localhost:27246` in a browser, log in, and click the workspace selector in the sidebar. Copy the workspace ID (format: `ws_...`).

### Step 5: Configure an MCP client

**Claude Code** (easiest):
```bash
claude mcp add --transport http nimblebrain-local http://localhost:27247/mcp
```

Or add to your project's `.mcp.json`:
```json
{
  "mcpServers": {
    "nimblebrain-local": {
      "type": "http",
      "url": "http://localhost:27247/mcp",
      "headers": {
        "X-Workspace-Id": "ws_your_workspace_id"
      }
    }
  }
}
```

When the client connects, it will:
1. Hit `/mcp`, get a 401 with the discovery URL
2. Follow the RFC 9728 discovery chain to find AuthKit
3. Open a browser for you to authenticate
4. Receive a JWT and start making authenticated MCP requests

### Step 6: Verify the connection

Once authenticated, the MCP client should show all tools available in your workspace. You can verify by asking the client to list its tools or run a simple tool call.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKOS_API_KEY` | — | WorkOS API key (can also be set in instance.json) |
| `MCP_MAX_SESSIONS` | 100 | Maximum concurrent MCP sessions |
| `MCP_SESSION_TTL_MS` | 1800000 (30min) | MCP session idle timeout |

## Security

- **JWT verification:** Access tokens are verified against AuthKit's JWKS endpoint (`/oauth2/jwks`). Tokens are RS256-signed JWTs with issuer validation.
- **Organization scoping:** If `organizationId` is configured, only users who are members of that organization can authenticate.
- **Workspace isolation:** Every MCP request is scoped to a workspace. Tools can only access data within that workspace.
- **Role-based filtering:** Tools are filtered by the user's organization role (`admin`/`member`). Some tools are only visible to admins.
- **Session management:** MCP sessions have a configurable TTL and are cleaned up automatically. Max concurrent sessions are enforced.

## Standalone Connect (Custom Login UI)

If you want MCP clients to authenticate through your own login UI instead of AuthKit's hosted page, use [Standalone Connect](https://workos.com/docs/authkit/mcp/standalone-connect):

1. AuthKit redirects the user to your configured Login URI
2. Your application authenticates the user through your existing system
3. Your application calls AuthKit's completion API to finalize the OAuth flow
4. AuthKit issues tokens and returns control to the MCP client

This preserves your authentication experience while using AuthKit for the OAuth token lifecycle.
