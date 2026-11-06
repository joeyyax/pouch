import { describe, expect, it } from "vitest";
import { BodyFrame } from "@/app/(app)/_ui/body-frame";

const policyOf = (images: boolean) => {
  const frame = BodyFrame({ html: "<p>hi</p>", title: "t", images }) as { props: { srcDoc: string } };
  return /Content-Security-Policy" content="([^"]+)"/.exec(frame.props.srcDoc)?.[1];
};

describe("BodyFrame", () => {
  it("shows inline images in a recipient's mail and fetches nothing", () => {
    expect(policyOf(false)).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  });

  it("loads https images in a layout preview", () => {
    expect(policyOf(true)).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src https: data:");
  });
});
