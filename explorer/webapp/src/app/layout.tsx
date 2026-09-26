import type { Metadata } from "next";
import { Bricolage_Grotesque, Geist_Mono } from "next/font/google";
import { AppShell } from '@/components/SiteHeader';
import { configuredFactory } from '@/lib/p2id/derive';
import { env } from '@/lib/env';
import "./globals.css";

const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "P2ID · Route four.meme fees to any @handle",
  description:
    "P2ID is integrating with four.meme to route token fees to X, Farcaster and Telegram handles. Recipients sign in to claim through P2ID. No wallet address needed.",
  openGraph: {
    title: "P2ID · Route four.meme fees to any @handle",
    description: "P2ID is integrating with four.meme to route token fees to X, Farcaster and Telegram handles. Recipients sign in to claim through P2ID. No wallet address needed.",
    siteName: "P2ID",
    type: "website",
  },
  twitter: { card: "summary_large_image", title: "P2ID · Route four.meme fees to any @handle" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${bricolage.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full"><AppShell factory={configuredFactory()} claimUrl={env.NEXT_PUBLIC_PVIUM_URL} docsUrl={env.NEXT_PUBLIC_SPEC_URL}>{children}</AppShell></body>
    </html>
  );
}
