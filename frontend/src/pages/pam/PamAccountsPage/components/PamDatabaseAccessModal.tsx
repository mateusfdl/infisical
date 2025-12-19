import { useState, useEffect, useRef } from "react";
import { faDatabase, faPlay, faStop, faClock } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { createNotification } from "@app/components/notifications";
import { Button, Modal, ModalContent } from "@app/components/v2";
import { PAMDatabaseService } from "@app/services/pam/pamDatabaseService";

type Props = {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  sessionId: string;
  resourceType: string;
  accountName: string;
};

export const PamDatabaseAccessModal = ({
  isOpen,
  onOpenChange,
  sessionId,
  resourceType,
  accountName
}: Props) => {
  const [query, setQuery] = useState("SELECT 1;");
  const [results, setResults] = useState<any[]>([]);
  const [fields, setFields] = useState<Array<{ name: string; dataType: string }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [serverInfo, setServerInfo] = useState<{ serverVersion?: string; database?: string }>({});
  const prevIsOpenRef = useRef(isOpen);
  const isConnectedRef = useRef(isConnected);

  // Keep ref in sync
  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  useEffect(() => {
    if (isOpen && sessionId) {
      connectDatabase();
    }

    // Disconnect when modal closes (transitions from true to false)
    if (prevIsOpenRef.current && !isOpen && isConnectedRef.current && sessionId) {
      PAMDatabaseService.disconnect(sessionId).catch(() => {});
      setIsConnected(false);
    }

    prevIsOpenRef.current = isOpen;
  }, [isOpen, sessionId]);

  const connectDatabase = async () => {
    try {
      setIsLoading(true);

      const result = await PAMDatabaseService.connect(sessionId);

      setServerInfo({
        serverVersion: result.serverVersion,
        database: result.database
      });

      setIsConnected(true);

      createNotification({
        text: "Connected to database!",
        type: "success"
      });
    } catch (error) {
      createNotification({
        text: `Connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        type: "error"
      });
    } finally {
      setIsLoading(false);
    }
  };

  const executeQuery = async () => {
    if (!isConnected || isLoading || !query.trim()) return;

    setIsLoading(true);
    setResults([]);
    setFields([]);

    try {
      const result = await PAMDatabaseService.executeQuery(sessionId, query.trim());

      if (result.fields) {
        setFields(result.fields);
      }

      if (result.rows) {
        setResults(result.rows);
      }

      createNotification({
        text: `Query completed! ${result.rowCount || 0} rows returned in ${result.executionTimeMs}ms.`,
        type: "success"
      });
    } catch (error) {
      createNotification({
        text: `Query error: ${error instanceof Error ? error.message : "Unknown error"}`,
        type: "error"
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      executeQuery();
    }
  };

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <ModalContent
        className="max-w-4xl max-h-[80vh] overflow-hidden"
        title={`Database Access: ${accountName}`}
        subTitle={
          <div className="flex items-center gap-2">
            <FontAwesomeIcon icon={faDatabase} className="text-sm" />
            <span>{resourceType.toUpperCase()}</span>
            {serverInfo.serverVersion && <span>• {serverInfo.serverVersion}</span>}
            {serverInfo.database && <span>• DB: {serverInfo.database}</span>}
            <span className={`ml-2 px-2 py-1 text-xs rounded ${
              isConnected ? "bg-green-500/20 text-green-400" :
              isLoading ? "bg-yellow-500/20 text-yellow-400" :
              "bg-red-500/20 text-red-400"
            }`}>
              {isConnected ? "Connected" : isLoading ? "Connecting..." : "Disconnected"}
            </span>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-mineshaft-300">SQL Query</label>
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full h-32 p-3 bg-mineshaft-800 border border-mineshaft-600 rounded-lg text-sm font-mono text-mineshaft-200 resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
              placeholder="Enter your SQL query here... (Ctrl+Enter to execute)"
              disabled={!isConnected || isLoading}
            />
            <div className="flex justify-between items-center">
              <span className="text-xs text-mineshaft-400">
                {isConnected ? "Press Ctrl+Enter to execute" : "Connecting to database..."}
              </span>
              <Button
                onClick={executeQuery}
                disabled={!isConnected || isLoading}
                isLoading={isLoading}
                colorSchema="primary"
                size="sm"
                leftIcon={<FontAwesomeIcon icon={faPlay} />}
              >
                {isLoading ? "Executing..." : "Execute Query"}
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-mineshaft-300">
              Results {results.length > 0 && `(${results.length} rows)`}
            </label>
            <div className="bg-mineshaft-800 border border-mineshaft-600 rounded-lg overflow-auto" style={{ maxHeight: "400px" }}>
              {results.length > 0 ? (
                <div className="p-4">
                  <table className="w-full text-sm">
                    <thead className="border-b border-mineshaft-600">
                      <tr>
                        {fields.map((field, index) => (
                          <th key={index} className="text-left p-2 font-medium text-mineshaft-300">
                            {field.name}
                            <span className="ml-1 text-xs text-mineshaft-500">
                              ({field.dataType})
                            </span>
                          </th>
                        ))}
                        {fields.length === 0 && results[0]?.map((_: any, index: number) => (
                          <th key={index} className="text-left p-2 font-medium text-mineshaft-300">
                            Column {index + 1}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((row, rowIndex) => (
                        <tr key={rowIndex} className="border-b border-mineshaft-700">
                          {row.map((value, cellIndex) => (
                            <td key={cellIndex} className="p-2 text-mineshaft-200 max-w-xs truncate">
                              {value === null ? (
                                <span className="text-mineshaft-500 italic">NULL</span>
                              ) : value === "" ? (
                                <span className="text-mineshaft-500 italic">[empty]</span>
                              ) : (
                                String(value)
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-32 text-mineshaft-400">
                  <FontAwesomeIcon icon={faDatabase} className="text-2xl mb-2 opacity-50" />
                  <p>{isLoading ? "Executing query..." : "No results yet"}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
};
