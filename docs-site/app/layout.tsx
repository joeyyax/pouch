import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Bricolage_Grotesque, Instrument_Sans } from "next/font/google";
import { Provider } from "@/components/provider";
import "./global.css";

const instrument = Instrument_Sans({ subsets: ["latin"], variable: "--font-instrument" });
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--font-bricolage" });

export const metadata: Metadata = {
  metadataBase: new URL("https://pouch.email/docs/"),
  title: { default: "Pouch docs", template: "%s · Pouch docs" },
  description: "Guides and the API reference for Pouch, the open-source send API for the email provider you already use.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${instrument.variable} ${bricolage.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
