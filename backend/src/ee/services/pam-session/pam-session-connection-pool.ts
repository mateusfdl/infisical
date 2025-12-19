import mysql from "mysql2/promise";
import { Client as PgClient } from "pg";
import { z } from "zod";

import { MySQLSessionCredentialsSchema } from "@app/ee/services/pam-resource/mysql/mysql-resource-schemas";
import { PostgresSessionCredentialsSchema } from "@app/ee/services/pam-resource/postgres/postgres-resource-schemas";

type TPostgresSessionCredentials = z.infer<typeof PostgresSessionCredentialsSchema>;
type TMySQLSessionCredentials = z.infer<typeof MySQLSessionCredentialsSchema>;
type DatabaseConnection = PgClient | mysql.Connection;

interface PooledConnection {
  sessionId: string;
  connection: DatabaseConnection;
  resourceType: "postgres" | "mysql";
  createdAt: Date;
  lastUsed: Date;
}

export class PAMSessionConnectionPool {
  private connections = new Map<string, PooledConnection>();

  private cleanupInterval: NodeJS.Timeout;

  constructor(
    private readonly maxIdleTimeMs: number = 5 * 60 * 1000, // 5 minutes
    private readonly healthCheckIntervalMs: number = 30 * 1000 // 30 seconds
  ) {
    // Start periodic cleanup of idle connections
    this.cleanupInterval = setInterval(() => {
      void this.cleanupIdleConnections();
    }, this.healthCheckIntervalMs);
  }

  async getConnection(sessionId: string): Promise<DatabaseConnection> {
    const existing = this.connections.get(sessionId);
    if (existing) {
      existing.lastUsed = new Date();
      return existing.connection;
    }

    throw new Error("No connection found for session. Call createConnection first.");
  }

  async createConnection(
    sessionId: string,
    credentials: TPostgresSessionCredentials | TMySQLSessionCredentials,
    resourceType: "postgres" | "mysql"
  ): Promise<DatabaseConnection> {
    // Check if connection already exists
    const existing = this.connections.get(sessionId);
    if (existing) {
      existing.lastUsed = new Date();
      return existing.connection;
    }

    let connection: DatabaseConnection;

    if (resourceType === "postgres") {
      connection = await PAMSessionConnectionPool.createPostgresConnection(credentials);
    } else {
      connection = await PAMSessionConnectionPool.createMySQLConnection(credentials);
    }

    const pooledConnection: PooledConnection = {
      sessionId,
      connection,
      resourceType,
      createdAt: new Date(),
      lastUsed: new Date()
    };

    this.connections.set(sessionId, pooledConnection);
    return connection;
  }

  private static async createPostgresConnection(credentials: TPostgresSessionCredentials): Promise<PgClient> {
    const client = new PgClient({
      host: credentials.host,
      port: credentials.port,
      database: credentials.database,
      user: credentials.username,
      password: credentials.password,
      ssl: credentials.sslEnabled
        ? {
            ca: credentials.sslCertificate,
            rejectUnauthorized: credentials.sslRejectUnauthorized
          }
        : false,
      connectionTimeoutMillis: 10000
    });

    await client.connect();
    return client;
  }

  private static async createMySQLConnection(credentials: TMySQLSessionCredentials): Promise<mysql.Connection> {
    const connection = await mysql.createConnection({
      host: credentials.host,
      port: credentials.port,
      database: credentials.database,
      user: credentials.username,
      password: credentials.password,
      ssl: credentials.sslEnabled
        ? {
            ca: credentials.sslCertificate,
            rejectUnauthorized: credentials.sslRejectUnauthorized
          }
        : undefined,
      connectTimeout: 10000
    });

    return connection;
  }

  async releaseConnection(sessionId: string): Promise<void> {
    const connection = this.connections.get(sessionId);
    if (connection) {
      connection.lastUsed = new Date();
    }
  }

  async closeConnection(sessionId: string): Promise<void> {
    const pooled = this.connections.get(sessionId);
    if (pooled) {
      try {
        if (pooled.resourceType === "postgres") {
          await (pooled.connection as PgClient).end();
        } else {
          await (pooled.connection as mysql.Connection).end();
        }
      } finally {
        this.connections.delete(sessionId);
      }
    }
  }

  async healthCheck(sessionId: string): Promise<boolean> {
    const pooled = this.connections.get(sessionId);
    if (!pooled) return false;

    try {
      if (pooled.resourceType === "postgres") {
        await (pooled.connection as PgClient).query("SELECT 1");
      } else {
        await (pooled.connection as mysql.Connection).execute("SELECT 1");
      }
      return true;
    } catch (error) {
      await this.closeConnection(sessionId);
      return false;
    }
  }

  private async cleanupIdleConnections(): Promise<void> {
    const now = new Date();
    const toDelete: string[] = [];

    for (const [sessionId, connection] of this.connections.entries()) {
      const idleTime = now.getTime() - connection.lastUsed.getTime();
      if (idleTime > this.maxIdleTimeMs) {
        toDelete.push(sessionId);
      }
    }

    await Promise.all(toDelete.map((sessionId) => this.closeConnection(sessionId)));
  }

  async closeAllConnections(): Promise<void> {
    const closePromises = Array.from(this.connections.keys()).map((sessionId) => this.closeConnection(sessionId));
    await Promise.allSettled(closePromises);
    this.connections.clear();
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    void this.closeAllConnections();
  }

  getConnectionCount(): number {
    return this.connections.size;
  }

  getConnectionInfo(): Array<{ sessionId: string; resourceType: string; createdAt: Date; lastUsed: Date }> {
    return Array.from(this.connections.values()).map((conn) => ({
      sessionId: conn.sessionId,
      resourceType: conn.resourceType,
      createdAt: conn.createdAt,
      lastUsed: conn.lastUsed
    }));
  }
}

// Global connection pool instance
export const pamConnectionPool = new PAMSessionConnectionPool();
