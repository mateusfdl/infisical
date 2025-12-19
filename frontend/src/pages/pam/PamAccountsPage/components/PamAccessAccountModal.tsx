import { useMemo, useState, useEffect } from "react";
import { faCopy } from "@fortawesome/free-regular-svg-icons";
import { faUpRightFromSquare, faDatabase } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import ms from "ms";

import { createNotification } from "@app/components/notifications";
import { FormLabel, IconButton, Input, Modal, ModalContent, Button } from "@app/components/v2";
import { apiRequest } from "@app/config/request";
import { PamResourceType, TPamAccount } from "@app/hooks/api/pam";
import { PamDatabaseAccessModal } from "./PamDatabaseAccessModal";

type Props = {
  account?: TPamAccount;
  accountPath?: string;
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  projectId: string;
};

export const PamAccessAccountModal = ({
  isOpen,
  onOpenChange,
  account,
  projectId,
  accountPath
}: Props) => {
  const [duration, setDuration] = useState("4h");
  const [isBrowserAccessLoading, setIsBrowserAccessLoading] = useState(false);
  const [showDatabaseModal, setShowDatabaseModal] = useState(false);
  const [sessionData, setSessionData] = useState<any>(null);
  const [isMainModalHidden, setIsMainModalHidden] = useState(false);

  const { protocol, hostname, port } = window.location;
  const portSuffix = port && port !== "80" && port !== "443" ? `:${port}` : "";
  const siteURL = `${protocol}//${hostname}${portSuffix}`;

  let fullAccountPath = account?.name ?? "";
  if (accountPath) {
    const path = accountPath.replace(/^\/+|\/+$/g, "");
    fullAccountPath = `${path}/${account?.name ?? ""}`;
  }

  const isDurationValid = useMemo(() => duration && ms(duration || "1s") > 0, [duration]);

  // Check if browser access is supported for this resource type
  const isBrowserAccessSupported = useMemo(() => {
    if (!account) return false;
    return [
      PamResourceType.Postgres,
      PamResourceType.MySQL
    ].includes(account.resource.resourceType);
  }, [account]);

  const handleBrowserAccess = async () => {
    if (!account || !isDurationValid) {
      return;
    }

    setIsBrowserAccessLoading(true);

    try {
      const { data } = await apiRequest.post(
        "/api/v1/pam/accounts/access",
        {
          accountPath: fullAccountPath,
          projectId,
          duration: cliDuration,
        }
      );

      setSessionData(data);

      createNotification({
        text: "Database session created successfully!",
        type: "success",
      });
    } catch (error) {
      createNotification({
        text: `Failed to create database session: ${error}`,
        type: "error",
      });
    } finally {
      setIsBrowserAccessLoading(false);
    }
  };

  const cliDuration = useMemo(() => {
    if (!duration) return duration;

    const unit = duration.replace(/[\d\s.-]/g, "");

    const dayOrLargerUnits = [
      "d",
      "day",
      "days",
      "w",
      "week",
      "weeks",
      "y",
      "yr",
      "yrs",
      "year",
      "years"
    ];

    // ms library does not handle months (M) so we do it separately
    if (unit === "M") {
      const value = parseInt(duration, 10);
      if (!Number.isNaN(value) && value > 0) {
        const hours = value * 30 * 24;
        return `${hours}h`;
      }
    } else if (dayOrLargerUnits.includes(unit.toLowerCase())) {
      const valueInMs = ms(duration);
      const oneHourInMs = 1000 * 60 * 60;

      if (typeof valueInMs === "number" && valueInMs > 0) {
        const hours = Math.floor(valueInMs / oneHourInMs);
        return `${hours}h`;
      }
    }

    return duration;
  }, [duration]);

  const command = useMemo(() => {
    if (!account) return "";

    switch (account.resource.resourceType) {
      case PamResourceType.Postgres:
      case PamResourceType.MySQL:
        return `infisical pam db access-account ${fullAccountPath} --project-id ${projectId} --duration ${cliDuration} --domain ${siteURL}`;
      case PamResourceType.SSH:
        return `infisical pam ssh access-account ${fullAccountPath} --project-id ${projectId} --duration ${cliDuration} --domain ${siteURL}`;
      case PamResourceType.Kubernetes:
        return `infisical pam kubernetes access-account ${fullAccountPath} --project-id ${projectId} --duration ${cliDuration} --domain ${siteURL}`;
      default:
        return "";
    }
  }, [account, fullAccountPath, projectId, cliDuration, siteURL]);

  // Open database modal when session data is available
  useEffect(() => {
    if (sessionData) {
      setIsMainModalHidden(true);
      setShowDatabaseModal(true);
    }
  }, [sessionData]);

  const handleDatabaseModalClose = async (open: boolean) => {
    if (!open && sessionData) {
      // Modal is closing - end the session first
      try {
        await apiRequest.post(`/api/v1/pam/sessions/${sessionData.sessionId}/end`);
      } catch (error) {
        // Silently handle cleanup errors
        console.error("Failed to end session:", error);
      }

      // Then update UI state
      setShowDatabaseModal(false);
      setIsMainModalHidden(false);
      setSessionData(null);
    }
  };

  if (!account) return null;

  return (
    <>
      <Modal isOpen={isOpen && !isMainModalHidden} onOpenChange={onOpenChange}>
        <ModalContent
          className="max-w-2xl pb-2"
          title="Access Account"
          subTitle={`Access ${account?.name || ''} using CLI or browser.`}
        >
          <FormLabel
            label="Duration"
            tooltipText="The maximum duration of your session. Ex: 1h, 3w, 30d"
          />
          <Input
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="permanent"
            isError={!isDurationValid}
          />

          {isBrowserAccessSupported && (
            <>
              <FormLabel label="Browser Access" className="mt-4" />
              <div className="flex gap-2">
                <Button
                  onClick={handleBrowserAccess}
                  isLoading={isBrowserAccessLoading}
                  disabled={!isDurationValid}
                  className="flex-1"
                  colorSchema="primary"
                  leftIcon={<FontAwesomeIcon icon={faDatabase} />}
                >
                  {isBrowserAccessLoading ? "Creating Session..." : "Connect via Browser"}
                </Button>
              </div>
              <p className="mt-2 text-xs text-mineshaft-400">
                Open a web-based SQL interface to query the database directly in your browser.
              </p>
            </>
          )}

          <div className={isBrowserAccessSupported ? "mt-6" : ""}>
            <FormLabel label="CLI Command" className="mt-4" />
            <div className="flex gap-2">
              <Input value={command} isDisabled />
              <IconButton
                ariaLabel="copy"
                variant="outline_bg"
                colorSchema="secondary"
                onClick={() => {
                  navigator.clipboard.writeText(command);

                  createNotification({
                    text: "Command copied to clipboard",
                    type: "info"
                  });

                  onOpenChange(false);
                }}
                className="w-10"
              >
                <FontAwesomeIcon icon={faCopy} />
              </IconButton>
            </div>
            <a
              href="https://infisical.com/docs/cli/overview"
              target="_blank"
              className="mt-2 flex h-4 w-fit items-center gap-2 border-b border-mineshaft-400 text-sm text-mineshaft-400 transition-colors duration-100 hover:border-yellow-400 hover:text-yellow-400"
              rel="noreferrer"
            >
              <span>Install the Infisical CLI</span>
              <FontAwesomeIcon icon={faUpRightFromSquare} className="size-3" />
            </a>
          </div>
        </ModalContent>
      </Modal>

      {sessionData && account && (
        <PamDatabaseAccessModal
          isOpen={showDatabaseModal}
          onOpenChange={handleDatabaseModalClose}
          sessionId={sessionData.sessionId}
          resourceType={sessionData.resourceType}
          accountName={account.name}
        />
      )}
    </>
  );
};
