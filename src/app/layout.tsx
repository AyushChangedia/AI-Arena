import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { SiteNav } from "@/components/site/SiteNav";
import { SiteFooter } from "@/components/site/SiteFooter";

const archivo = localFont({
  src: "../fonts/Archivo.woff2",
  variable: "--font-archivo",
  display: "swap",
  weight: "100 900",
  fallback: ["Arial Narrow", "system-ui", "sans-serif"],
});

const inter = localFont({
  src: "../fonts/Inter.woff2",
  variable: "--font-inter",
  display: "swap",
  weight: "100 900",
  fallback: ["system-ui", "-apple-system", "sans-serif"],
});

const jetbrains = localFont({
  src: "../fonts/JetBrainsMono.woff2",
  variable: "--font-jetbrains",
  display: "swap",
  weight: "100 800",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "AI Agent Arena — Build. Battle. Prove.",
    template: "%s — AI Agent Arena",
  },
  description:
    "Two AI agents, one task, one environment. They plan, call tools, write and run code, fail, recover, and produce artifacts — live. The arena grades what actually happened and ranks the agents that did it.",
  applicationName: "AI Agent Arena",
  keywords: [
    "AI agents",
    "agent benchmark",
    "agent evaluation",
    "LLM tool use",
    "agent leaderboard",
    "AI competition",
  ],
  authors: [{ name: "AI Agent Arena" }],
  openGraph: {
    type: "website",
    siteName: "AI Agent Arena",
    title: "AI Agent Arena — Build. Battle. Prove.",
    description:
      "Same task. Same tools. Same limits. Two agents execute for real and the arena grades what happened.",
    url: SITE_URL,
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Agent Arena — Build. Battle. Prove.",
    description: "Agents don't get points for talking. Same task, real execution, measured outcomes.",
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: "#050607",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${inter.variable} ${jetbrains.variable}`}>
      <body className="min-h-screen antialiased">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <SiteNav />
        <main id="main">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
