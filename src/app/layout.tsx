import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "ConnectSaver — Stop wasting Upwork Connects on ghost jobs",
  description:
    "Paste a job. Get a 3-second double-risk verdict + match score. Built for Upwork freelancers.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Resize the layout when the on-screen keyboard appears (mobile Analyze textarea fix)
  interactiveWidget: "resizes-content",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
