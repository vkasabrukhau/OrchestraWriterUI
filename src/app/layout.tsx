import type { Metadata, Viewport } from "next";
import { Inter, Lora } from "next/font/google";
import "./globals.css";
import { SessionHydrator } from "@/lib/auth/SessionHydrator";
import { ThemeSync } from "@/components/shell/ThemeSync";
import { EDITOR_SURFACE_SCRIPT } from "@/components/shell/editor-steps";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { Toaster } from "@/components/ui/Toaster";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const lora = Lora({
  variable: "--font-lora",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Orchestra Visualizer",
    template: "%s · Orchestra Visualizer",
  },
  description:
    "See which parts of the orchestra are playing, and how loud the score says they are, while the recording plays.",
};

export const viewport: Viewport = {
  themeColor: "#f6f2ea",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${lora.variable} h-full`} suppressHydrationWarning>
      <head>
        {/* editor pages (ADR 0014) get their surface tokens before first paint */}
        <script dangerouslySetInnerHTML={{ __html: EDITOR_SURFACE_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        <SessionHydrator />
        <ThemeSync />
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </body>
    </html>
  );
}
