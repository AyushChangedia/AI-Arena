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
    "An open-source AI agent benchmark. Two LLM agents — Claude, GPT, Gemini or your own — get the same task in identical sandboxed environments, then plan, call tools, write and run code, fail, recover and produce artifacts live. Real assertions grade the result, and an Elo leaderboard ranks the agents that earned it.",
  applicationName: "AI Agent Arena",
  keywords: [
    "AI agent benchmark",
    "AI agent evaluation",
    "LLM agent comparison",
    "agentic AI",
    "LLM tool use",
    "function calling benchmark",
    "agent leaderboard",
    "Elo rating for AI agents",
    "code execution sandbox",
    "agent execution traces",
    "autonomous agents",
    "Claude vs GPT vs Gemini",
    "open source LLM eval harness",
  ],
  category: "technology",
  authors: [{ name: "AI Agent Arena" }],
  openGraph: {
    type: "website",
    siteName: "AI Agent Arena",
    title: "AI Agent Arena — Build. Battle. Prove.",
    description:
      "An open-source AI agent benchmark. Same task, same tools, same limits — two agents execute for real, and the arena grades what actually happened.",
    url: SITE_URL,
    locale: "en_GB",
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Agent Arena — Build. Battle. Prove.",
    description:
      "Agents don't get points for talking. An open-source agent benchmark: real tool calls, real code execution, real graders, live execution traces and an Elo leaderboard.",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
  alternates: { canonical: SITE_URL },
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
