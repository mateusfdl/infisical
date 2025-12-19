/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BadRequestError } from "@app/lib/errors";
import { ActorType } from "@app/services/auth/auth-type";

import { PamResource } from "../../pam-resource/pam-resource-enums";
import { PamPostgresTcpGatewayService } from "./pam-pgsql-tcp-gateway-service";

describe("PamPostgresTcpGatewayService - Real Logic Tests", () => {
  let service: any;
  const mockGatewayV2Service = {
    getPAMConnectionDetails: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    service = new (PamPostgresTcpGatewayService as any)(mockGatewayV2Service);
  });

  describe("getGatewayConnectionDetails - Connection Details Transformation", () => {
    it("transforms nested connection details to flat structure", async () => {
      const mockResponse = {
        relayHost: "relay.infisical.com:8443",
        relay: {
          clientCertificate: "-----BEGIN CERTIFICATE-----\nRELAY_CERT\n-----END CERTIFICATE-----",
          clientPrivateKey: "-----BEGIN PRIVATE KEY-----\nRELAY_KEY\n-----END PRIVATE KEY-----", // gitleaks:allow
          serverCertificateChain: "-----BEGIN CERTIFICATE-----\nRELAY_CHAIN\n-----END CERTIFICATE-----"
        },
        gateway: {
          clientCertificate: "-----BEGIN CERTIFICATE-----\nGATEWAY_CERT\n-----END CERTIFICATE-----",
          clientPrivateKey: "-----BEGIN PRIVATE KEY-----\nGATEWAY_KEY\n-----END PRIVATE KEY-----", // gitleaks:allow
          serverCertificateChain: "-----BEGIN CERTIFICATE-----\nGATEWAY_CHAIN\n-----END CERTIFICATE-----"
        }
      };

      mockGatewayV2Service.getPAMConnectionDetails.mockResolvedValue(mockResponse);

      const result = await service.getGatewayConnectionDetails("session-123", "gateway-456", "project-789");

      expect(result.relayHost).toEqual("relay.infisical.com:8443");
      expect(result.relayClientCertificate).toEqual(mockResponse.relay.clientCertificate);
      expect(result.relayClientPrivateKey).toEqual(mockResponse.relay.clientPrivateKey);
      expect(result.relayServerCertificateChain).toEqual(mockResponse.relay.serverCertificateChain);
      expect(result.gatewayClientCertificate).toEqual(mockResponse.gateway.clientCertificate);
      expect(result.gatewayClientPrivateKey).toEqual(mockResponse.gateway.clientPrivateKey);
      expect(result.gatewayServerCertificateChain).toEqual(mockResponse.gateway.serverCertificateChain);
      expect(result.sessionId).toEqual("session-123");
    });

    it("calls gateway service with correct parameters", async () => {
      const mockResponse = {
        relayHost: "relay.example.com",
        relay: { clientCertificate: "cert", clientPrivateKey: "key", serverCertificateChain: "chain" },
        gateway: { clientCertificate: "cert", clientPrivateKey: "key", serverCertificateChain: "chain" }
      };

      mockGatewayV2Service.getPAMConnectionDetails.mockResolvedValue(mockResponse);

      await service.getGatewayConnectionDetails("sess-001", "gw-002", "proj-003");

      expect(mockGatewayV2Service.getPAMConnectionDetails).toHaveBeenCalledWith({
        sessionId: "sess-001",
        gatewayIdentityId: "gw-002",
        resourceType: PamResource.Postgres,
        host: "localhost",
        port: 8443,
        actorMetadata: {
          id: "system",
          type: ActorType.USER,
          name: "PAM TCP Gateway"
        }
      });
    });

    it("throws BadRequestError when connection details are null", async () => {
      mockGatewayV2Service.getPAMConnectionDetails.mockResolvedValue(null);

      await expect(service.getGatewayConnectionDetails("session-123", "gw-456", "proj-789")).rejects.toThrow(
        BadRequestError
      );
      await expect(service.getGatewayConnectionDetails("session-123", "gw-456", "proj-789")).rejects.toThrow(
        "Failed to get gateway connection details"
      );
    });

    it("throws BadRequestError when connection details are undefined", async () => {
      mockGatewayV2Service.getPAMConnectionDetails.mockResolvedValue(undefined);

      await expect(service.getGatewayConnectionDetails("session-123", "gw-456", "proj-789")).rejects.toThrow(
        BadRequestError
      );
    });

    it("handles partial connection details with missing certificates", async () => {
      const partialResponse = {
        relayHost: "relay.example.com",
        relay: {
          clientCertificate: undefined,
          clientPrivateKey: "key",
          serverCertificateChain: "chain"
        },
        gateway: {
          clientCertificate: "cert",
          clientPrivateKey: undefined,
          serverCertificateChain: undefined
        }
      };

      mockGatewayV2Service.getPAMConnectionDetails.mockResolvedValue(partialResponse);

      const result = await service.getGatewayConnectionDetails("session-123", "gw-456", "proj-789");

      expect(result.relayClientCertificate).toBeUndefined();
      expect(result.relayClientPrivateKey).toEqual("key");
      expect(result.gatewayClientCertificate).toEqual("cert");
      expect(result.gatewayClientPrivateKey).toBeUndefined();
      expect(result.gatewayServerCertificateChain).toBeUndefined();
    });

    it("preserves sessionId in result", async () => {
      const mockResponse = {
        relayHost: "relay.example.com",
        relay: { clientCertificate: "c", clientPrivateKey: "k", serverCertificateChain: "ch" },
        gateway: { clientCertificate: "c", clientPrivateKey: "k", serverCertificateChain: "ch" }
      };

      mockGatewayV2Service.getPAMConnectionDetails.mockResolvedValue(mockResponse);

      const result1 = await service.getGatewayConnectionDetails("session-AAA", "gw-1", "proj-1");
      const result2 = await service.getGatewayConnectionDetails("session-BBB", "gw-1", "proj-1");

      expect(result1.sessionId).toEqual("session-AAA");
      expect(result2.sessionId).toEqual("session-BBB");
    });
  });

  describe("Tunnel Management - State Tracking", () => {
    it("starts with zero active tunnels", () => {
      expect(service.getActiveTunnelCount()).toEqual(0);
      expect(service.getActiveTunnels()).toEqual([]);
    });

    it("tracks tunnel count correctly", () => {
      const initialCount = service.getActiveTunnelCount();
      expect(initialCount).toEqual(0);

      const tunnels = service.getActiveTunnels();
      expect(Array.isArray(tunnels)).toEqual(true);
      expect(tunnels.length).toEqual(initialCount);
    });

    it("returns empty array when no tunnels exist", () => {
      const tunnels = service.getActiveTunnels();
      expect(tunnels).toEqual([]);
      expect(tunnels.length).toEqual(0);
    });

    it("closes all tunnels when none exist", async () => {
      await expect(service.closeAllTunnels()).resolves.not.toThrow();
      expect(service.getActiveTunnelCount()).toEqual(0);
    });

    it("handles multiple closeAllTunnels calls", async () => {
      await service.closeAllTunnels();
      await service.closeAllTunnels();
      await service.closeAllTunnels();

      expect(service.getActiveTunnelCount()).toEqual(0);
    });
  });

  describe("Gateway Service Integration", () => {
    it("handles gateway service errors gracefully", async () => {
      mockGatewayV2Service.getPAMConnectionDetails.mockRejectedValue(new Error("Gateway unavailable"));

      await expect(service.getGatewayConnectionDetails("session-123", "gw-456", "proj-789")).rejects.toThrow(
        "Gateway unavailable"
      );
    });

    it("handles gateway service timeout", async () => {
      mockGatewayV2Service.getPAMConnectionDetails.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Timeout")), 100);
          })
      );

      await expect(service.getGatewayConnectionDetails("session-123", "gw-456", "proj-789")).rejects.toThrow("Timeout");
    });

    it("handles malformed gateway response", async () => {
      mockGatewayV2Service.getPAMConnectionDetails.mockResolvedValue({
        // Missing required fields
        relay: {},
        gateway: {}
      });

      const result = await service.getGatewayConnectionDetails("session-123", "gw-456", "proj-789");

      expect(result.relayHost).toBeUndefined();
      expect(result.sessionId).toEqual("session-123");
    });
  });
});
