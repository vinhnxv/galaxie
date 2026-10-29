# MCP reference server

Development reference for protocol 2025-11-25 over Streamable HTTP, using the pinned MCP SDK. This example is not a production gateway.

Build with `pnpm build`. Import `startMcpServer` from `./dist/index.js` and pass `allowedOrigins` and `verifyToken(token)`, returning your authenticated principal or `undefined`. The returned `url` uses `127.0.0.1` and an ephemeral port unless `port` is supplied; call `close()` during shutdown. Node callers must send an allowed `Origin` too. Tokens should be short-lived and issued by the host.

Every request checks Origin; every non-preflight request authenticates. Sessions belong to the verified principal. CORS allows GET, POST and DELETE and the MCP protocol/session headers, exposing the session ID. Attribution in tool-call `_meta` never authorizes a request.

`lesson.lookup` returns a lesson title, `text.echo` returns text, and `progress.record` maintains a principal-scoped practice counter deduplicated by effect ID. A real backend must authorize access to the lesson and implement durable effect deduplication. The in-process `admin` API supports tests and has no HTTP route. Nothing is persisted.
