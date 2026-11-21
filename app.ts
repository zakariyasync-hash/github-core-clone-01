// app.ts — one-process HTTP server for the github-core-clone forge.
//
// Routes:
//   GET  /healthz                                  liveness probe (no auth)
//   GET|POST /:owner/:repo.git/info/refs           git smart-HTTP advertisement
//   POST /:owner/:repo.git/git-upload-pack         git protocol v2 / v0 fetch
//   POST /:owner/:repo.git/git-receive-pack        git receive-pack v0 (push)
//   /api/v3/*                                      REST v3 (Bearer auth)
//   POST /api/graphql                              GraphQL v4 (Bearer auth)
//   POST /mcp                                      MCP (Bearer auth)
//
// Auth: the exact token from MAKEFUN_SHOP_TOKEN when it is set; when it is empty
// (local development) any non-empty Bearer token is accepted. Unauthenticated calls
// answer 401 with a JSON body. Every reply carries X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQLBody } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { ForgeStore, type ForgeStore as ForgeStoreType } from './store.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestCounter = 0;
const requestId = (): string => {
  requestCounter += 1;
  return `req-${requestCounter}`;
};

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const bearer = /^Bearer\s+(.+)$/.exec(header);
  if (bearer !== null) return bearer[1];
  // Real git clients authenticate with Basic; accept user:token or token: as the
  // password, the way GitHub's own HTTP endpoints do.
  const basic = /^Basic\s+(.+)$/.exec(header);
  if (basic !== null) {
    try {
      const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon >= 0) return decoded.slice(colon + 1) === '' ? decoded.slice(0, colon) : decoded.slice(colon + 1);
      return decoded;
    } catch {
      return null;
    }
  }
  return null;
}

function isAuthenticated(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return token === expected;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': requestId(),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, bytes: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(bytes.length),
    'x-github-request-id': requestId(),
  });
  res.end(bytes);
}

function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' }, { 'www-authenticate': 'Basic realm="github-core-clone"' });
}

function sendNoBody(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId() });
  res.end();
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function splitPath(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '').map(decodeSegment);
}

export function createApp(): Server {
  const store: ForgeStoreType = new ForgeStore();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rid = requestId();
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      const segments = splitPath(url.pathname);

      // -- liveness -----------------------------------------------------------
      if (method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      // -- MCP ---------------------------------------------------------------
      if (segments[0] === 'mcp') {
        if (method !== 'POST') {
          sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } });
          return;
        }
        if (!isAuthenticated(req)) {
          sendUnauthorized(res);
          return;
        }
        const body = await readBody(req);
        const result = handleMcp(store, body.toString('utf8'));
        sendJson(res, result.status, result.body);
        return;
      }

      // -- GraphQL ------------------------------------------------------------
      if (segments[0] === 'api' && segments[1] === 'graphql') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        if (!isAuthenticated(req)) {
          sendUnauthorized(res);
          return;
        }
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
          return;
        }
        const result = executeGraphQLBody(store, parsed);
        sendJson(res, 200, result);
        return;
      }

      // -- REST v3 ------------------------------------------------------------
      if (segments[0] === 'api' && segments[1] === 'v3') {
        if (!isAuthenticated(req)) {
          sendUnauthorized(res);
          return;
        }
        let body: Record<string, unknown> | null = null;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
            } catch {
              sendJson(res, 400, { message: 'Malformed JSON body' });
              return;
            }
          }
        }
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
        const result = handleRest(store, method, segments.slice(2), url.searchParams, body, origin, url.pathname);
        if (result.status === 204) {
          sendNoBody(res, 204);
          return;
        }
        sendJson(res, result.status, result.body, result.headers ?? {});
        return;
      }

      // -- Git smart HTTP -----------------------------------------------------
      if (segments.length >= 3 && segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
        const owner = segments[0];
        const repoName = segments[1].replace(/\.git$/, '');
        const service = url.searchParams.get('service') ?? '';
        if (!isAuthenticated(req)) {
          sendUnauthorized(res);
          return;
        }
        // The Git-Protocol header carries the value "version=2"; normalise it
        // to "2" before the protocol handlers compare it.
        const gitProtocol = req.headers['git-protocol'] === 'version=2' ? '2' : '';
        const out = handleInfoRefs(store, owner, repoName, service, gitProtocol);
        sendBytes(res, out.status, out.body, out.contentType);
        return;
      }
      if (segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack') && method === 'POST') {
        const owner = segments[0];
        const repoName = segments[1].replace(/\.git$/, '');
        if (!isAuthenticated(req)) {
          sendUnauthorized(res);
          return;
        }
        const body = await readBody(req);
        const gitProtocol = req.headers['git-protocol'] === 'version=2' ? '2' : '';
        const out =
          segments[2] === 'git-upload-pack'
            ? handleUploadPack(store, owner, repoName, body, gitProtocol)
            : handleReceivePack(store, owner, repoName, body);
        sendBytes(res, out.status, out.body, out.contentType);
        return;
      }

      // -- fallback ------------------------------------------------------------
      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      console.error(`[${rid}] handler error:`, err instanceof Error ? err.message : String(err));
      if (!res.headersSent) {
        sendJson(res, 500, { message: 'Internal Server Error' });
      } else {
        res.end();
      }
    }
  });

  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}
