import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LiveIndicator } from "@/app/(app)/messages/live-indicator";

/**
 * The pulse on the live dot is the signal, not decoration. Dropping it under reduced motion
 * leaves a plain dot that reads the same as "connecting", so the still equivalent has to ship
 * with it — in CSS, where it applies before hydration and can't disagree with the server.
 */
describe("the live dot under reduced motion", () => {
  const markup = renderToStaticMarkup(createElement(LiveIndicator, { state: "live" }));

  it("pulses when motion is allowed", () => {
    expect(markup).toContain("motion-safe:animate-pulse");
  });

  it("carries a ring instead when it isn't", () => {
    expect(markup).toContain("motion-reduce:ring-2");
    expect(markup).toContain("ring-success/40");
  });

  it("never animates unconditionally", () => {
    expect(markup).not.toMatch(/(?<!motion-safe:)animate-pulse/);
  });
});
