import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <img src="/docs/icon.svg" alt="" width={24} height={24} />
          <span className="font-display text-[1.05rem] font-bold tracking-tight">Pouch</span>
        </>
      ),
      url: "https://pouch.email/",
    },
    githubUrl: "https://github.com/joeyyax/pouch",
    links: [{ text: "pouch.email", url: "https://pouch.email/", external: true }],
  };
}
