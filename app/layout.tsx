import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tłumacz napisów AI",
  description: "Kontekstowe tłumaczenie napisów SRT i VTT między polskim i angielskim.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pl">
      <body>{children}</body>
    </html>
  );
}
