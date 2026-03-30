import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import AuthProvider from "@/components/auth/AuthProvider";
import SubscriptionProvider from "@/components/auth/SubscriptionProvider";
import PostHogProvider from "@/components/PostHogProvider";
import "./globals.css";

const geist = Geist({
  variable: "--font-serif",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Autocut",
  description: "AI-powered video editor. Cut, caption, and edit via chat.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
    apple: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geist.variable} ${geistMono.variable} antialiased`}>
        <PostHogProvider>
          <AuthProvider>
            <SubscriptionProvider>{children}</SubscriptionProvider>
          </AuthProvider>
        </PostHogProvider>
      </body>
    </html>
  );
}
