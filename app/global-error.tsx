"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { reportClientError } from "@/lib/errors/client";
import "./globals.css";

/** The root layout itself failed, so this brings its own document. Reports the first path segment only. */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    reportClientError(error, 1);
  }, [error]);

  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">
        <div className="py-16">
          <EmptyState
            icon="warning"
            titleAs="h2"
            title="This page didn’t load"
            description="Something broke before it could show. Try again."
            action={
              <Button size="md" onClick={retry}>
                Try again
              </Button>
            }
          />
        </div>
      </body>
    </html>
  );
}
