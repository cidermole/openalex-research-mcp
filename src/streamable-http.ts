import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { CONFIG, VERSION, debug } from './config.js';
import { createOpenAlexMcpServer } from './openalex-mcp-server.js';

type Session = {
  transport: StreamableHTTPServerTransport;
  open: number;
  lastActive: number;
};

const DEFAULT_PORT = 3100;
const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 500;

const sessions = new Map<string, Session>();

function trackResponse(session: Session, res: ServerResponse): void {
  if (!res.socket || res.destroyed) return;
  session.open++;
  res.on('close', () => {
    session.open--;
    session.lastActive = Date.now();
  });
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

export async function startStreamableHttpServer(): Promise<void> {
  const port = parseInt(process.env.PORT || process.env.MCP_HTTP_PORT || String(DEFAULT_PORT), 10);
  const path = process.env.MCP_HTTP_PATH || '/mcp';

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: VERSION, transport: 'streamable-http' });
  });

  const postHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;
      const session = sessionId ? sessions.get(sessionId) : undefined;

      if (session) {
        transport = session.transport;
        trackResponse(session, res);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        if (sessions.size >= MAX_SESSIONS) {
          jsonRpcError(res, 503, -32000, 'Too many open sessions');
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            debug('Streamable HTTP session initialized:', id);
            sessions.set(id, sessionRef);
          },
        });
        const sessionRef: Session = { transport, open: 0, lastActive: Date.now() };

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            sessions.delete(sid);
            debug('Streamable HTTP session closed:', sid);
          }
        };

        const server = createOpenAlexMcpServer();
        await server.connect(transport);
        trackResponse(sessionRef, res);
        await transport.handleRequest(req, res, req.body);
        return;
      } else if (sessionId) {
        jsonRpcError(res, 404, -32001, 'Session not found');
        return;
      } else {
        jsonRpcError(res, 400, -32000, 'Bad Request: No valid session ID provided');
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[openalex] Error handling MCP HTTP request:', error);
      jsonRpcError(res, 500, -32603, 'Internal server error');
    }
  };

  const getHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).send('Missing session ID');
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      jsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    trackResponse(session, res);
    await session.transport.handleRequest(req, res);
  };

  const deleteHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      res.status(400).send('Missing session ID');
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      jsonRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    trackResponse(session, res);
    await session.transport.handleRequest(req, res);
  };

  app.post(path, (req, res) => {
    void postHandler(req, res);
  });
  app.get(path, (req, res) => {
    void getHandler(req, res);
  });
  app.delete(path, (req, res) => {
    void deleteHandler(req, res);
  });

  const idleSweep = setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, { transport, open, lastActive }] of sessions) {
      if (open === 0 && lastActive < cutoff) {
        transport.close().catch((err) => console.error('[openalex] Failed to close idle session', id, err));
      }
    }
  }, 60_000);
  idleSweep.unref();

  const shutdown = async () => {
    for (const [id, { transport }] of sessions) {
      try {
        await transport.close();
      } catch (err) {
        console.error('[openalex] Error closing session', id, err);
      }
    }
    sessions.clear();
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.error(
        `[openalex] MCP Streamable HTTP server listening on http://127.0.0.1:${port}${path} (OpenAlex API: ${CONFIG.API.BASE_URL})`,
      );
      resolve();
    });
  });
}
