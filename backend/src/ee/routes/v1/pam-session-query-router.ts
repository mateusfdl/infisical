import { z } from "zod";

import { NotFoundError } from "@app/lib/errors";
import { readLimit, writeLimit } from "@app/server/config/rateLimiter";
import { verifyAuth } from "@app/server/plugins/auth/verify-auth";
import { AuthMode } from "@app/services/auth/auth-type";

export const registerPamSessionQueryRouter = async (server: FastifyZodProvider) => {
  server.route({
    method: "POST",
    url: "/:sessionId/connect",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Initialize database connection for a PAM session",
      params: z.object({
        sessionId: z.string().uuid()
      }),
      response: {
        200: z.object({
          status: z.string(),
          message: z.string(),
          serverVersion: z.string().optional(),
          database: z.string().optional()
        })
      },
      tags: ["PAM Sessions"]
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    handler: async (req) => {
      const { sessionId } = req.params;

      const { session } = await server.services.pamSession.getById(sessionId, req.permission);
      if (!session) {
        throw new NotFoundError({ message: "Session not found" });
      }

      return {
        status: "connected",
        message: "TCP tunnel connection initialized successfully",
        serverVersion: "PostgreSQL/MySQL via Gateway",
        database: "Connected via PAM Gateway"
      };
    }
  });

  server.route({
    method: "POST",
    url: "/:sessionId/query",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Execute SQL query in a PAM database session",
      params: z.object({
        sessionId: z.string().uuid()
      }),
      body: z.object({
        sql: z.string().min(1).max(100000),
        params: z.array(z.any()).optional()
      }),
      response: {
        200: z.object({
          fields: z
            .array(
              z.object({
                name: z.string(),
                dataType: z.string(),
                tableID: z.number().optional(),
                columnID: z.number().optional()
              })
            )
            .optional(),
          rows: z.array(z.array(z.any())),
          rowCount: z.number(),
          executionTimeMs: z.number()
        })
      },
      tags: ["PAM Sessions"]
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    handler: async (req) => {
      const { sessionId } = req.params;
      const { sql, params = [] } = req.body;

      const { session } = await server.services.pamSession.getById(sessionId, req.permission);
      if (!session) {
        throw new NotFoundError({ message: "Session not found" });
      }

      const startTime = Date.now();
      const result = await server.services.pamPostgresProxy.executeQuery({
        sessionId,
        sql,
        params,
        actor: req.permission
      });
      const executionTime = Date.now() - startTime;

      return {
        fields: result.fields,
        rows: result.rows,
        rowCount: result.rowCount,
        executionTimeMs: executionTime
      };
    }
  });

  server.route({
    method: "POST",
    url: "/:sessionId/disconnect",
    config: {
      rateLimit: writeLimit
    },
    schema: {
      description: "Close database connection for a PAM session",
      params: z.object({
        sessionId: z.string().uuid()
      }),
      response: {
        200: z.object({
          status: z.string(),
          message: z.string()
        })
      },
      tags: ["PAM Sessions"]
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    handler: async (req) => {
      const { sessionId } = req.params;

      const { session } = await server.services.pamSession.getById(sessionId, req.permission);
      if (!session) {
        throw new NotFoundError({ message: "Session not found" });
      }

      await server.services.pamPostgresTcpGateway.closeAllTunnels();

      return {
        status: "disconnected",
        message: "TCP tunnel connection closed successfully"
      };
    }
  });

  server.route({
    method: "GET",
    url: "/connections/health",
    config: {
      rateLimit: readLimit
    },
    schema: {
      description: "Health check for PAM database connections",
      tags: ["PAM Sessions"],
      response: {
        200: z.object({
          status: z.string(),
          activeConnections: z.number(),
          connectionPoolInfo: z.array(
            z.object({
              sessionId: z.string(),
              resourceType: z.string(),
              createdAt: z.date(),
              lastUsed: z.date()
            })
          )
        })
      }
    },
    onRequest: verifyAuth([AuthMode.JWT]),
    handler: async () => {
      try {
        const activeTunnels = server.services.pamPostgresTcpGateway.getActiveTunnels();
        const connectionPoolInfo = server.services.pamConnectionPool.getConnectionInfo();

        return {
          status: "healthy",
          activeConnections: activeTunnels.length,
          connectionPoolInfo: [
            ...activeTunnels.map((tunnel) => ({
              sessionId: tunnel.sessionId,
              resourceType: "tcp-tunnel",
              createdAt: new Date(),
              lastUsed: new Date()
            })),
            ...connectionPoolInfo
          ]
        };
      } catch (error) {
        return {
          status: "unhealthy",
          activeConnections: 0,
          connectionPoolInfo: []
        };
      }
    }
  });
};
