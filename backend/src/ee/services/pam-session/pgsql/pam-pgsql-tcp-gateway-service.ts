import * as net from "net";
import { Client } from "pg";
import * as tls from "tls";
import { z } from "zod";

import { PostgresSessionCredentialsSchema } from "@app/ee/services/pam-resource/postgres/postgres-resource-schemas";
import { BadRequestError } from "@app/lib/errors";
import { ActorType } from "@app/services/auth/auth-type";

import { TGatewayV2ServiceFactory } from "../../gateway-v2/gateway-v2-service";
import { PamResource } from "../../pam-resource/pam-resource-enums";

interface PostgresGatewayConnectionDetails {
  relayHost: string;
  relayClientCertificate: string;
  relayClientPrivateKey: string;
  relayServerCertificateChain: string;
  gatewayClientCertificate: string;
  gatewayClientPrivateKey: string;
  gatewayServerCertificateChain: string;
  sessionId: string;
}

interface PostgresTunnelConnection {
  relaySocket: tls.TLSSocket;
  gatewaySocket: tls.TLSSocket;
  isActive: boolean;
}

export class PamPostgresTcpGatewayService {
  private activeTunnels = new Map<string, PostgresTunnelConnection>();

  constructor(private gatewayV2Service: TGatewayV2ServiceFactory) {}

  async executeQueryThroughTunnel(
    sessionId: string,
    credentials: z.infer<typeof PostgresSessionCredentialsSchema>,
    gatewayDetails: PostgresGatewayConnectionDetails,
    sql: string
  ): Promise<{
    fields: Array<{ name: string; dataType: string }>;
    rows: Array<unknown[]>;
    rowCount: number;
    success: boolean;
  }> {
    try {
      const relaySocket = await PamPostgresTcpGatewayService.createRelayConnection(gatewayDetails);

      const gatewaySocket = await PamPostgresTcpGatewayService.createGatewayConnection(relaySocket, gatewayDetails);

      const tunnel: PostgresTunnelConnection = {
        relaySocket,
        gatewaySocket,
        isActive: true
      };
      this.activeTunnels.set(sessionId, tunnel);

      const result = await PamPostgresTcpGatewayService.executeQueryByType(gatewaySocket, credentials, sql);

      await this.closeTunnel(sessionId);

      return result;
    } catch (error) {
      await this.closeTunnel(sessionId);
      throw new BadRequestError({
        message: error instanceof Error ? error.message : "Failed to execute query through TCP tunnel"
      });
    }
  }

  private static async createRelayConnection(gatewayDetails: PostgresGatewayConnectionDetails): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const { relayHost, relayClientCertificate, relayClientPrivateKey, relayServerCertificateChain } = gatewayDetails;

      let host = relayHost;
      let port = 8443;

      if (relayHost.includes(":")) {
        const [hostPart, portStr] = relayHost.split(":");
        host = hostPart;
        port = parseInt(portStr, 10);
      }

      // Validate required certificates
      if (!relayClientCertificate || !relayClientPrivateKey || !relayServerCertificateChain) {
        reject(new Error("Missing relay TLS certificates or keys"));
        return;
      }

      const tlsConfig: tls.ConnectionOptions = {
        host,
        port,
        cert: relayClientCertificate,
        key: relayClientPrivateKey,
        ca: relayServerCertificateChain,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        servername: host
      };

      const socket = tls.connect(tlsConfig, () => {
        if (socket.authorized) {
          resolve(socket);
        } else {
          reject(new Error(`Relay TLS authorization failed: ${String(socket.authorizationError)}`));
        }
      });

      socket.on("error", (error: Error) => {
        reject(new Error(`Relay TLS connection error: ${error.message}`));
      });

      socket.setTimeout(10000, () => {
        reject(new Error("Relay connection timeout after 10 seconds"));
      });
    });
  }

  private static async createGatewayConnection(
    relaySocket: tls.TLSSocket,
    gatewayDetails: PostgresGatewayConnectionDetails
  ): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const { gatewayClientCertificate, gatewayClientPrivateKey, gatewayServerCertificateChain } = gatewayDetails;

      if (!gatewayClientCertificate || !gatewayClientPrivateKey || !gatewayServerCertificateChain) {
        reject(new Error("Missing gateway TLS certificates or keys"));
        return;
      }

      const tlsConfig: tls.ConnectionOptions = {
        cert: gatewayClientCertificate,
        key: gatewayClientPrivateKey,
        ca: gatewayServerCertificateChain,
        rejectUnauthorized: false,
        minVersion: "TLSv1.2",
        maxVersion: "TLSv1.3",
        ALPNProtocols: ["infisical-pam-proxy"],
        servername: "localhost"
      };

      const gatewaySocket = tls.connect({
        ...tlsConfig,
        socket: relaySocket
      });

      gatewaySocket.once("secureConnect", () => {
        if (gatewaySocket.getProtocol()) {
          gatewaySocket.setTimeout(0);
          resolve(gatewaySocket);
        } else {
          reject(new Error(`Gateway TLS handshake failed: ${String(gatewaySocket.authorizationError)}`));
        }
      });

      gatewaySocket.on("error", (error: Error) => {
        reject(new Error(`Gateway TLS connection error: ${error.message}`));
      });

      gatewaySocket.setTimeout(10000, () => {
        reject(new Error("Gateway connection timeout after 10 seconds"));
      });
    });
  }

  private static async executeQueryByType(
    gatewaySocket: tls.TLSSocket,
    credentials: z.infer<typeof PostgresSessionCredentialsSchema>,
    sql: string
  ): Promise<{
    fields: Array<{ name: string; dataType: string }>;
    rows: Array<unknown[]>;
    rowCount: number;
    success: boolean;
  }> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((clientSocket) => {
        clientSocket.pipe(gatewaySocket);
        gatewaySocket.pipe(clientSocket);

        clientSocket.on("error", () => {
          // Ignore errors during socket cleanup
        });
        gatewaySocket.on("error", () => {
          // Ignore errors during socket cleanup
        });
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as net.AddressInfo;
        const localPort = address.port;

        const executeQuery = async () => {
          try {
            const client = new Client({
              host: "127.0.0.1",
              port: localPort,
              database: credentials.database,
              user: credentials.username,
              password: credentials.password,
              ssl: false,
              connectionTimeoutMillis: 10000
            });

            await client.connect();
            const result = await client.query(sql);

            await client.end();
            server.close();

            const rowsAsArrays: unknown[][] = result.rows.map((row: Record<string, unknown>) =>
              result.fields.map((field) => row[field.name])
            );

            resolve({
              fields: result.fields.map((f) => ({
                name: f.name,
                dataType: f.dataTypeID.toString()
              })),
              rows: rowsAsArrays,
              rowCount: result.rowCount || 0,
              success: true
            });
          } catch (error) {
            server.close();
            reject(error);
          }
        };

        void executeQuery();
      });

      server.on("error", (err) => {
        reject(err);
      });
    });
  }

  private async closeTunnel(sessionId: string): Promise<void> {
    const tunnel = this.activeTunnels.get(sessionId);
    if (tunnel) {
      tunnel.isActive = false;

      try {
        if (tunnel.gatewaySocket && !tunnel.gatewaySocket.destroyed) {
          tunnel.gatewaySocket.destroy();
        }
        if (tunnel.relaySocket && !tunnel.relaySocket.destroyed) {
          tunnel.relaySocket.destroy();
        }
      } catch {
        // Ignore errors during socket cleanup
      }

      this.activeTunnels.delete(sessionId);
    }
  }

  async getGatewayConnectionDetails(
    sessionId: string,
    gatewayIdentityId: string
  ): Promise<PostgresGatewayConnectionDetails> {
    const connectionDetails = await this.gatewayV2Service.getPAMConnectionDetails({
      sessionId,
      gatewayIdentityId,
      resourceType: PamResource.Postgres,
      host: "localhost",
      port: 8443,
      actorMetadata: {
        id: "system",
        type: ActorType.USER,
        name: "PAM TCP Gateway"
      }
    });

    if (!connectionDetails) {
      throw new BadRequestError({ message: "Failed to get gateway connection details" });
    }

    const relayClientCertificate = connectionDetails.relay?.clientCertificate;
    const relayClientPrivateKey = connectionDetails.relay?.clientPrivateKey;
    const relayServerCertificateChain = connectionDetails.relay?.serverCertificateChain;
    const gatewayClientCertificate = connectionDetails.gateway?.clientCertificate;
    const gatewayClientPrivateKey = connectionDetails.gateway?.clientPrivateKey;
    const gatewayServerCertificateChain = connectionDetails.gateway?.serverCertificateChain;

    return {
      relayHost: connectionDetails.relayHost,
      relayClientCertificate,
      relayClientPrivateKey,
      relayServerCertificateChain,
      gatewayClientCertificate,
      gatewayClientPrivateKey,
      gatewayServerCertificateChain,
      sessionId
    };
  }

  async closeAllTunnels(): Promise<void> {
    const closePromises = Array.from(this.activeTunnels.keys()).map((sessionId) => this.closeTunnel(sessionId));
    await Promise.allSettled(closePromises);
  }

  getActiveTunnelCount(): number {
    return this.activeTunnels.size;
  }

  getActiveTunnels(): Array<{ sessionId: string; isActive: boolean }> {
    return Array.from(this.activeTunnels.entries()).map(([sessionId, tunnel]) => ({
      sessionId,
      isActive: tunnel.isActive
    }));
  }
}

export type TPamPostgresTcpGatewayServiceFactory = ReturnType<typeof pamPostgresTcpGatewayServiceFactory>;

export const pamPostgresTcpGatewayServiceFactory = ({
  gatewayV2Service
}: {
  gatewayV2Service: TGatewayV2ServiceFactory;
}) => {
  return new PamPostgresTcpGatewayService(gatewayV2Service);
};
