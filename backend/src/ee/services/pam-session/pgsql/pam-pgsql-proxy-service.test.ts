/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BadRequestError } from "@app/lib/errors";

import { PamSessionStatus } from "../pam-session-enums";
import { PamPostgresProxyService } from "./pam-pgsql-proxy-service";

describe("PamPostgresProxyService - Real Logic Tests", () => {
  let service: any;
  const mockPamSessionDAL = {
    findById: vi.fn()
  };
  const mockPamAccountDAL = {
    findById: vi.fn()
  };
  const mockPamResourceDAL = {
    findById: vi.fn()
  };
  const mockPamAccountService = {
    getSessionCredentials: vi.fn()
  };
  const mockGatewayV2Service = {
    getPAMConnectionDetails: vi.fn()
  };
  const mockPostgresTcpGatewayService = {
    executeQueryThroughTunnel: vi.fn()
  };

  const mockActor = {
    type: "USER" as any,
    id: "actor-1",
    authMethod: "jwt" as any,
    orgId: "org-1",
    rootOrgId: "org-1",
    parentOrgId: "org-1"
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new (PamPostgresProxyService as any)(
      mockPamSessionDAL,
      mockPamAccountDAL,
      mockPamResourceDAL,
      mockPamAccountService,
      mockGatewayV2Service,
      mockPostgresTcpGatewayService
    );
  });

  describe("validateSession - Session Status Logic", () => {
    it("rejects ended sessions", async () => {
      const endedSession = {
        id: "session-1",
        status: PamSessionStatus.Ended,
        accountId: "acc-1",
        projectId: "proj-1",
        expiresAt: null
      };

      mockPamSessionDAL.findById.mockResolvedValue(endedSession);

      const result = service.validateSession("session-1", mockActor);

      await expect(result).rejects.toThrow(BadRequestError);
      await expect(result).rejects.toThrow("Session has ended");
    });

    it("rejects expired sessions even if status is Active", async () => {
      const expiredSession = {
        id: "session-1",
        status: PamSessionStatus.Active,
        accountId: "acc-1",
        projectId: "proj-1",
        expiresAt: new Date(Date.now() - 1000)
      };

      mockPamSessionDAL.findById.mockResolvedValue(expiredSession);

      const result = service.validateSession("session-1", mockActor);

      await expect(result).rejects.toThrow(BadRequestError);
      await expect(result).rejects.toThrow("Session has expired");
    });

    it("accepts active session without expiration", async () => {
      const activeSession = {
        id: "session-1",
        status: PamSessionStatus.Active,
        accountId: "acc-1",
        projectId: "proj-1",
        expiresAt: null
      };

      mockPamSessionDAL.findById.mockResolvedValue(activeSession);

      const result = await service.validateSession("session-1", mockActor);

      expect(result).toEqual(activeSession);
    });

    it("accepts active session with future expiration", async () => {
      const futureDate = new Date(Date.now() + 3600000);
      const activeSession = {
        id: "session-1",
        status: PamSessionStatus.Active,
        accountId: "acc-1",
        projectId: "proj-1",
        expiresAt: futureDate
      };

      mockPamSessionDAL.findById.mockResolvedValue(activeSession);

      const result = await service.validateSession("session-1", mockActor);

      expect(result).toEqual(activeSession);
      expect(result.expiresAt).toEqual(futureDate);
    });

    it("accepts Starting status as valid", async () => {
      const startingSession = {
        id: "session-1",
        status: PamSessionStatus.Starting,
        accountId: "acc-1",
        projectId: "proj-1",
        expiresAt: new Date(Date.now() + 3600000)
      };

      mockPamSessionDAL.findById.mockResolvedValue(startingSession);

      const result = await service.validateSession("session-1", mockActor);

      expect(result).toEqual(startingSession);
    });

    it("handles session exactly at expiration boundary", async () => {
      const now = new Date();
      const sessionAtBoundary = {
        id: "session-1",
        status: PamSessionStatus.Active,
        accountId: "acc-1",
        projectId: "proj-1",
        expiresAt: now
      };

      mockPamSessionDAL.findById.mockResolvedValue(sessionAtBoundary);

      const result = service.validateSession("session-1", mockActor);

      await expect(result).rejects.toThrow("Session has expired");
    });
  });

  describe("getResourceForSession - Cascade Validation Logic", () => {
    it("validates complete resource chain", async () => {
      const session = { accountId: "acc-1" };
      const account = { id: "acc-1", resourceId: "res-1" };
      const resource = { id: "res-1", gatewayId: "gw-1" };

      mockPamAccountDAL.findById.mockResolvedValue(account);
      mockPamResourceDAL.findById.mockResolvedValue(resource);

      const result = await service.getResourceForSession(session);

      expect(result).toEqual(resource);
      expect(mockPamAccountDAL.findById).toHaveBeenCalledWith("acc-1");
      expect(mockPamResourceDAL.findById).toHaveBeenCalledWith("res-1");
    });

    it("throws error if account is missing", async () => {
      const session = { accountId: "acc-missing" };
      mockPamAccountDAL.findById.mockResolvedValue(null);

      await expect(service.getResourceForSession(session)).rejects.toThrow("Account not found");
      expect(mockPamResourceDAL.findById).not.toHaveBeenCalled();
    });

    it("throws error if resource is missing", async () => {
      const session = { accountId: "acc-1" };
      const account = { id: "acc-1", resourceId: "res-missing" };

      mockPamAccountDAL.findById.mockResolvedValue(account);
      mockPamResourceDAL.findById.mockResolvedValue(null);

      await expect(service.getResourceForSession(session)).rejects.toThrow("Resource not found");
    });

    it("throws error if gateway is not configured on resource", async () => {
      const session = { accountId: "acc-1" };
      const account = { id: "acc-1", resourceId: "res-1" };
      const resourceWithoutGateway = { id: "res-1", gatewayId: null };

      mockPamAccountDAL.findById.mockResolvedValue(account);
      mockPamResourceDAL.findById.mockResolvedValue(resourceWithoutGateway);

      await expect(service.getResourceForSession(session)).rejects.toThrow(
        "Resource does not have a gateway configured"
      );
    });

    it("throws error if gateway is undefined", async () => {
      const session = { accountId: "acc-1" };
      const account = { id: "acc-1", resourceId: "res-1" };
      const resourceWithoutGateway = { id: "res-1", gatewayId: undefined };

      mockPamAccountDAL.findById.mockResolvedValue(account);
      mockPamResourceDAL.findById.mockResolvedValue(resourceWithoutGateway);

      await expect(service.getResourceForSession(session)).rejects.toThrow(
        "Resource does not have a gateway configured"
      );
    });

    it("accepts resource with valid gateway ID", async () => {
      const session = { accountId: "acc-1" };
      const account = { id: "acc-1", resourceId: "res-1" };
      const resourceWithGateway = { id: "res-1", gatewayId: "gateway-123" };

      mockPamAccountDAL.findById.mockResolvedValue(account);
      mockPamResourceDAL.findById.mockResolvedValue(resourceWithGateway);

      const result = await service.getResourceForSession(session);

      expect(result.gatewayId).toEqual("gateway-123");
    });
  });

  describe("executeQueryThroughTunnel - Connection Details Transformation", () => {
    it("correctly transforms nested gateway details structure", async () => {
      const credentials = {
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "user",
        password: "pass",
        sslEnabled: false,
        sslRejectUnauthorized: true,
        sslCertificate: undefined
      };

      const gatewayDetails = {
        relayHost: "relay.example.com:8443",
        relay: {
          clientCertificate: "relay-cert-data",
          clientPrivateKey: "relay-key-data",
          serverCertificateChain: "relay-chain-data"
        },
        gateway: {
          clientCertificate: "gateway-cert-data",
          clientPrivateKey: "gateway-key-data",
          serverCertificateChain: "gateway-chain-data"
        }
      };

      mockPostgresTcpGatewayService.executeQueryThroughTunnel.mockResolvedValue({
        fields: [],
        rows: [],
        rowCount: 0,
        success: true
      });

      await service.executeQueryThroughTunnel(credentials, gatewayDetails, "SELECT 1", [], "session-1");

      const callArgs = mockPostgresTcpGatewayService.executeQueryThroughTunnel.mock.calls[0];
      const transformedDetails = callArgs[2];

      expect(transformedDetails.relayHost).toEqual("relay.example.com:8443");
      expect(transformedDetails.relayClientCertificate).toEqual("relay-cert-data");
      expect(transformedDetails.relayClientPrivateKey).toEqual("relay-key-data");
      expect(transformedDetails.relayServerCertificateChain).toEqual("relay-chain-data");
      expect(transformedDetails.gatewayClientCertificate).toEqual("gateway-cert-data");
      expect(transformedDetails.gatewayClientPrivateKey).toEqual("gateway-key-data");
      expect(transformedDetails.gatewayServerCertificateChain).toEqual("gateway-chain-data");
      expect(transformedDetails.sessionId).toEqual("session-1");
    });

    it("handles missing optional certificate fields gracefully", async () => {
      const credentials = {
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "user",
        password: "pass",
        sslEnabled: false,
        sslRejectUnauthorized: true,
        sslCertificate: undefined
      };

      const gatewayDetailsPartial = {
        relayHost: "relay.example.com",
        relay: undefined,
        gateway: undefined
      };

      mockPostgresTcpGatewayService.executeQueryThroughTunnel.mockResolvedValue({
        fields: [],
        rows: [],
        rowCount: 0,
        success: true
      });

      await service.executeQueryThroughTunnel(credentials, gatewayDetailsPartial, "SELECT 1", [], "session-1");

      const callArgs = mockPostgresTcpGatewayService.executeQueryThroughTunnel.mock.calls[0];
      const transformedDetails = callArgs[2];

      expect(transformedDetails.relayClientCertificate).toBeUndefined();
      expect(transformedDetails.gatewayClientCertificate).toBeUndefined();
    });
  });

  describe("getSessionCredentials - Fetches Real Credentials", () => {
    it("returns credentials from PAM account service", async () => {
      const mockCredentials = {
        host: "db.example.com",
        port: 5432,
        database: "production",
        username: "app_user",
        password: "secure_password",
        sslEnabled: true,
        sslRejectUnauthorized: true,
        sslCertificate: "-----BEGIN CERTIFICATE-----"
      };

      mockPamAccountService.getSessionCredentials.mockResolvedValue({
        credentials: mockCredentials,
        projectId: "proj-1",
        account: { id: "acc-1" },
        sessionStarted: false
      });

      const credentials = await service.getSessionCredentials("session-1", mockActor);

      expect(credentials).toEqual(mockCredentials);
      expect(mockPamAccountService.getSessionCredentials).toHaveBeenCalledWith("session-1", mockActor);
    });

    it("propagates errors from PAM account service", async () => {
      mockPamAccountService.getSessionCredentials.mockRejectedValue(new Error("Session not found"));

      await expect(service.getSessionCredentials("missing-session", mockActor)).rejects.toThrow("Session not found");
    });

    it("returns credentials with proper structure", async () => {
      const mockCredentials = {
        host: "localhost",
        port: 5432,
        database: "testdb",
        username: "testuser",
        password: "testpass",
        sslEnabled: false,
        sslRejectUnauthorized: false,
        sslCertificate: undefined
      };

      mockPamAccountService.getSessionCredentials.mockResolvedValue({
        credentials: mockCredentials,
        projectId: "proj-1",
        account: { id: "acc-1" },
        sessionStarted: true
      });

      const result = await service.getSessionCredentials("session-1", mockActor);

      expect(result.host).toEqual("localhost");
      expect(result.port).toEqual(5432);
      expect(result.database).toEqual("testdb");
      expect(result.username).toEqual("testuser");
      expect(result.password).toEqual("testpass");
      expect(result.sslEnabled).toEqual(false);
      expect(result.sslRejectUnauthorized).toEqual(false);
      expect(result.sslCertificate).toEqual(undefined);
    });
  });
});
