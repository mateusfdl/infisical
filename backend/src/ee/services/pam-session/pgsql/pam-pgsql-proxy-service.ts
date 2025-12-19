import { z } from "zod";

import { PostgresSessionCredentialsSchema } from "@app/ee/services/pam-resource/postgres/postgres-resource-schemas";
import { BadRequestError, NotFoundError } from "@app/lib/errors";
import { OrgServiceActor } from "@app/lib/types";
import { ActorType } from "@app/services/auth/auth-type";

import { TGatewayV2ServiceFactory } from "../../gateway-v2/gateway-v2-service";
import { TPamAccountDALFactory } from "../../pam-account/pam-account-dal";
import { TPamAccountServiceFactory } from "../../pam-account/pam-account-service";
import { TPamResourceDALFactory } from "../../pam-resource/pam-resource-dal";
import { PamResource } from "../../pam-resource/pam-resource-enums";
import { TPamSessionDALFactory } from "../pam-session-dal";
import { PamSessionStatus } from "../pam-session-enums";
import { TPamPostgresTcpGatewayServiceFactory } from "./pam-pgsql-tcp-gateway-service";

interface PostgresExecuteQueryParams {
  sessionId: string;
  sql: string;
  params: unknown[];
}

interface PostgresQueryResult {
  fields?: Array<{
    name: string;
    dataType: string;
    tableID?: number;
    columnID?: number;
  }>;
  rows: Array<unknown[]>;
  rowCount: number;
}

export class PamPostgresProxyService {
  constructor(
    private pamSessionDAL: TPamSessionDALFactory,
    private pamAccountDAL: TPamAccountDALFactory,
    private pamResourceDAL: TPamResourceDALFactory,
    private pamAccountService: TPamAccountServiceFactory,
    private gatewayV2Service: TGatewayV2ServiceFactory,
    private postgresTcpGatewayService: TPamPostgresTcpGatewayServiceFactory
  ) {}

  async executeQuery(params: PostgresExecuteQueryParams & { actor: OrgServiceActor }): Promise<PostgresQueryResult> {
    const { sessionId, sql, params: queryParams, actor } = params;

    try {
      const session = await this.validateSession(sessionId);
      const resource = await this.getResourceForSession(session);
      const credentials = await this.getSessionCredentials(sessionId, actor);
      const gatewayConnectionDetails = await this.getGatewayConnectionDetails(sessionId, resource.gatewayId!);

      if (!gatewayConnectionDetails) {
        throw new BadRequestError({ message: "Failed to get gateway connection details" });
      }

      const result = await this.executeQueryThroughTunnel(
        credentials,
        gatewayConnectionDetails,
        sql,
        queryParams,
        sessionId
      );

      return result;
    } catch (error) {
      throw new BadRequestError({
        message: error instanceof Error ? error.message : "Failed to execute query via gateway"
      });
    }
  }

  private async validateSession(sessionId: string) {
    const sessionFromDb = await this.pamSessionDAL.findById(sessionId);
    if (!sessionFromDb) {
      throw new NotFoundError({ message: `Session with ID '${sessionId}' not found` });
    }

    if (sessionFromDb.status === PamSessionStatus.Ended) {
      throw new BadRequestError({ message: "Session has ended" });
    }

    if (sessionFromDb.expiresAt && new Date(sessionFromDb.expiresAt) <= new Date()) {
      throw new BadRequestError({ message: "Session has expired" });
    }

    return sessionFromDb;
  }

  private async getResourceForSession(session: { accountId: string }) {
    const account = await this.pamAccountDAL.findById(session.accountId);
    if (!account) {
      throw new NotFoundError({ message: "Account not found" });
    }

    const resource = await this.pamResourceDAL.findById(account.resourceId);
    if (!resource) {
      throw new NotFoundError({ message: "Resource not found" });
    }

    if (!resource.gatewayId) {
      throw new BadRequestError({ message: "Resource does not have a gateway configured" });
    }

    return resource;
  }

  private async getSessionCredentials(sessionId: string, actor: OrgServiceActor) {
    const { credentials } = await this.pamAccountService.getSessionCredentials(sessionId, actor);
    return credentials as z.infer<typeof PostgresSessionCredentialsSchema>;
  }

  private async getGatewayConnectionDetails(sessionId: string, gatewayId: string) {
    try {
      const connectionDetails = await this.gatewayV2Service.getPAMConnectionDetails({
        sessionId,
        gatewayId,
        resourceType: PamResource.Postgres,
        host: "localhost",
        port: 8443,
        actorMetadata: {
          id: "system",
          type: ActorType.USER,
          name: "PAM Gateway Proxy"
        }
      });

      if (!connectionDetails) {
        throw new BadRequestError({
          message: "No connection details returned from gateway service"
        });
      }

      return connectionDetails;
    } catch (error) {
      throw new BadRequestError({
        message: "Failed to get gateway connection details for TCP tunnel"
      });
    }
  }

  private async executeQueryThroughTunnel(
    credentials: z.infer<typeof PostgresSessionCredentialsSchema>,
    gatewayDetails: {
      relayHost?: string;
      relay?: {
        clientCertificate?: string;
        clientPrivateKey?: string;
        serverCertificateChain?: string;
      };
      gateway?: {
        clientCertificate?: string;
        clientPrivateKey?: string;
        serverCertificateChain?: string;
      };
    },
    sql: string,
    params: unknown[],
    sessionId: string
  ): Promise<PostgresQueryResult> {
    const tunnelDetails = {
      relayHost: gatewayDetails.relayHost,
      relayClientCertificate: gatewayDetails.relay?.clientCertificate,
      relayClientPrivateKey: gatewayDetails.relay?.clientPrivateKey,
      relayServerCertificateChain: gatewayDetails.relay?.serverCertificateChain,
      gatewayClientCertificate: gatewayDetails.gateway?.clientCertificate,
      gatewayClientPrivateKey: gatewayDetails.gateway?.clientPrivateKey,
      gatewayServerCertificateChain: gatewayDetails.gateway?.serverCertificateChain,
      sessionId
    };

    return this.postgresTcpGatewayService.executeQueryThroughTunnel(sessionId, credentials, tunnelDetails, sql);
  }
}

export type TPamPostgresProxyServiceFactory = ReturnType<typeof pamPostgresProxyServiceFactory>;

export const pamPostgresProxyServiceFactory = ({
  pamSessionDAL,
  pamAccountDAL,
  pamResourceDAL,
  pamAccountService,
  gatewayV2Service,
  postgresTcpGatewayService
}: {
  pamSessionDAL: TPamSessionDALFactory;
  pamAccountDAL: TPamAccountDALFactory;
  pamResourceDAL: TPamResourceDALFactory;
  pamAccountService: TPamAccountServiceFactory;
  gatewayV2Service: TGatewayV2ServiceFactory;
  postgresTcpGatewayService: TPamPostgresTcpGatewayServiceFactory;
}) => {
  return new PamPostgresProxyService(
    pamSessionDAL,
    pamAccountDAL,
    pamResourceDAL,
    pamAccountService,
    gatewayV2Service,
    postgresTcpGatewayService
  );
};
