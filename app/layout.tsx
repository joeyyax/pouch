import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Caveat, Instrument_Sans } from "next/font/google";
import { Announcer } from "@/components/ui/announcer";
import { ToastHost } from "@/components/ui/toast-host";
import { brand } from "@/lib/brand";
import { THEME_INIT } from "@/lib/theme-init";
import "./globals.css";

// The three faces the kit's tokens read, under the variable names it expects.
const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});

const instrument = Instrument_Sans({
  subsets: ["latin"],
  style: ["normal", "italic"],
  variable: "--font-instrument",
  display: "swap",
});

const caveat = Caveat({
  subsets: ["latin"],
  variable: "--font-caveat",
  display: "swap",
});

export const metadata: Metadata = {
  title: brand.dashboardTitle,
  description: "Transactional email with a provider-agnostic core.",
};

// Next's defaults plus `cover`, so `env(safe-area-inset-*)` reports the notch and home indicator.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: THEME_INIT adds .dark before React hydrates,
    // so the server and client class lists differ on purpose.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${bricolage.variable} ${instrument.variable} ${caveat.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        {children}
        <ToastHost />
        <Announcer />
      </body>
    </html>
  );
}
