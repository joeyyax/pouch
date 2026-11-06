"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { reportClientError } from "@/lib/errors/client";
import { logger } from "@/lib/logger";

/** Whatever the screen was, it didn't load. Says so once, and offers the only useful action. */
export default function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    logger.child("dashboard").error(`screen failed: ${error.message}`);
    reportClientError(error);
  }, [error]);

  return (
    <div className="py-16">
      <EmptyState
        icon="warning"
        titleAs="h2"
        title="This screen didn’t load"
        description="The database or object storage didn’t answer. Nothing was lost."
        action={
          <Button size="md" onClick={retry}>
            Try again
          </Button>
        }
      />
    </div>
  );
}
