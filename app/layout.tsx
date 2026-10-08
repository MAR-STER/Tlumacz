import type { Metadata, Viewport } from "next";
import PwaRegister from "./pwa-register";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tłumacz napisów AI",
  description: "Kontekstowe tłumaczenie napisów SRT i VTT między polskim i angielskim.",
  manifest: "/manifest.webmanifest",
  applicationName: "Tłumacz napisów AI",
  appleWebApp: {
    capable: true,
    title: "Tłumacz",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/pwa/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [
      { url: "/pwa/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
  },
};

export const viewport: Viewport = {
  themeColor: "#05070b",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pl">
      <body>
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
