import { apiRequest } from "@app/config/request";

export interface QueryResult {
  fields?: Array<{
    name: string;
    dataType: string;
    tableID?: number;
    columnID?: number;
  }>;
  rows?: Array<any[]>;
  rowCount?: number;
  executionTimeMs?: number;
}

export interface QueryError {
  message: string;
  code?: string;
  severity?: string;
  position?: number;
}

export type ConnectionState = "connecting" | "connected" | "disconnected" | "error" | "expired";

export interface ConnectionInfo {
  status: string;
  message: string;
  serverVersion?: string;
  database?: string;
}

export class PAMDatabaseService {
  static async connect(sessionId: string): Promise<ConnectionInfo> {
    const { data } = await apiRequest.post<ConnectionInfo>(
      `/api/v1/pam/sessions/${sessionId}/connect`
    );
    return data;
  }

  static async executeQuery(sessionId: string, sql: string, params: any[] = []): Promise<QueryResult> {
    const { data } = await apiRequest.post<QueryResult>(
      `/api/v1/pam/sessions/${sessionId}/query`,
      { sql, params }
    );
    return data;
  }

  static async disconnect(sessionId: string): Promise<void> {
    await apiRequest.post(`/api/v1/pam/sessions/${sessionId}/disconnect`);
  }

  static async getHealthInfo(): Promise<{
    status: string;
    activeConnections: number;
    connectionPoolInfo: Array<{
      sessionId: string;
      resourceType: string;
      createdAt: Date;
      lastUsed: Date;
    }>;
  }> {
    const { data } = await apiRequest.get("/api/v1/pam/sessions/connections/health");
    return data;
  }
}
