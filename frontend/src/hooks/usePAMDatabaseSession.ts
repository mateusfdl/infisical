import { useState, useCallback, useEffect, useRef } from "react";
import { apiRequest } from "@app/config/request";
import { PAMDatabaseService, ConnectionState, QueryResult, QueryError } from "@app/services/pam/pamDatabaseService";

export interface Query {
  id: string;
  sql: string;
  timestamp: Date;
  result?: QueryResult;
  error?: QueryError;
  executionTimeMs?: number;
}

export function usePAMDatabaseSession(accountPath: string, projectId: string) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [queryHistory, setQueryHistory] = useState<Query[]>([]);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  const createSession = useCallback(async (duration: string) => {
    try {
      const { data } = await apiRequest.post("/api/v1/pam/accounts/access", {
        accountPath,
        projectId,
        duration,
      });

      setSessionId(data.sessionId);

      const durationMs = parseDuration(duration);
      if (durationMs) {
        setExpiresAt(new Date(Date.now() + durationMs));
      }

      return data;
    } catch (error) {
      throw error;
    }
  }, [accountPath, projectId]);

  const connect = useCallback(async (sid: string) => {
    try {
      setConnectionState("connecting");
      setIsExecuting(true);

      const result = await PAMDatabaseService.connect(sid);

      setConnectionState("connected");
      setIsConnected(true);
      setSessionId(sid);

      return result;
    } catch (error) {
      setConnectionState("error");
      setIsConnected(false);
      throw error;
    } finally {
      setIsExecuting(false);
    }
  }, []);

  const executeQuery = useCallback(async (sql: string): Promise<QueryResult> => {
    if (!sessionId || !isConnected) {
      throw new Error("Not connected to database");
    }

    const queryId = Date.now().toString();
    const startTime = Date.now();

    const newQuery: Query = {
      id: queryId,
      sql: sql.trim(),
      timestamp: new Date(),
    };

    setQueryHistory((prev: Query[]) => [newQuery, ...prev]);

    try {
      setIsExecuting(true);
      const result = await PAMDatabaseService.executeQuery(sessionId, sql);
      const executionTime = Date.now() - startTime;

      setQueryHistory((prev: Query[]) => prev.map(q =>
        q.id === queryId
          ? { ...q, result, executionTimeMs: executionTime }
          : q
      ));

      return result;
    } catch (error) {
      const queryError: QueryError = {
        message: error instanceof Error ? error.message : "Unknown error"
      };

      setQueryHistory((prev: Query[]) => prev.map(q =>
        q.id === queryId
          ? { ...q, error: queryError, executionTimeMs: Date.now() - startTime }
          : q
      ));

      throw error;
    } finally {
      setIsExecuting(false);
    }
  }, [sessionId, isConnected]);

  const endSession = useCallback(async () => {
    try {
      if (sessionId && isConnected) {
        await PAMDatabaseService.disconnect(sessionId);
        setIsConnected(false);
      }

      if (sessionId) {
        await apiRequest.post(`/api/v1/pam/sessions/${sessionId}/end`);
        setSessionId(null);
        setExpiresAt(null);
      }

      setConnectionState("disconnected");
    } catch (error) {
      // Silently handle session ending errors
    }
  }, [sessionId, isConnected]);

  const clearHistory = useCallback(() => {
    setQueryHistory([]);
  }, []);

  // Check session expiration
  useEffect(() => {
    if (!expiresAt) return;

    const checkExpiration = () => {
      const now = new Date();
      if (now >= expiresAt) {
        setConnectionState("expired");
        setIsConnected(false);
        if (sessionId) {
          PAMDatabaseService.disconnect(sessionId);
        }
      }
    };

    const interval = setInterval(checkExpiration, 5000); // Check every 5 seconds
    return () => clearInterval(interval);
  }, [expiresAt, sessionId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sessionId && isConnected) {
        PAMDatabaseService.disconnect(sessionId);
      }
    };
  }, [sessionId, isConnected]);

  return {
    sessionId,
    connectionState,
    isExecuting,
    isConnected,
    queryHistory,
    expiresAt,
    executeQuery,
    createSession,
    connect,
    endSession,
    clearHistory,
  };
}

// Helper function to parse duration strings like "4h", "30m", "1d"
function parseDuration(duration: string): number | null {
  const match = duration.match(/^(\d+)([smhdw])$/);
  if (!match) return null;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
}
