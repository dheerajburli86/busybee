import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BusyBee - Task Management",
  description: "Internal task tracking and deadline management",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100">{children}</body>
    </html>
  );
}
