import type { Metadata, Viewport } from "next";
import "./theme.css";
import "./globals.css";
import { RegisterSW } from "@/components/pwa/RegisterSW";
import { SPLASH_SCREENS } from "@/lib/splash";
import { THEME_SCRIPT } from "@/lib/theme";

// BusyBee installs as an app on phones, tablets and computers (no app store):
// manifest + icons + launch screens here, the service worker in public/sw.js.
export const metadata: Metadata = {
  title: "BusyBee - Task Management",
  description: "Internal task tracking and deadline management",
  applicationName: "BusyBee",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: { capable: true, title: "BusyBee", statusBarStyle: "black-translucent", startupImage: SPLASH_SCREENS },
  formatDetection: { telephone: false, email: false, address: false },
  other: { "apple-mobile-web-app-capable": "yes", "bb-release": process.env.NEXT_PUBLIC_RELEASE || "" },
};

// Checklist #45: scale to the device and allow both orientations.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000000",
  colorScheme: "dark light",
};

// Android shows its own "Install" bar unless the page takes the offer; BusyBee
// takes it here, before React loads, so its own Install buttons can use it.
const CATCH_INSTALL = `window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.__bbInstall=e;window.dispatchEvent(new Event("bb-installable"))});window.addEventListener("appinstalled",function(){window.__bbInstall=null;window.dispatchEvent(new Event("bb-installed"))});`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-theme is set before the page is drawn (THEME_SCRIPT), so React
    // mustn't complain that it differs from this default.
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: CATCH_INSTALL }} />
      </head>
      <body className="bg-slate-950 text-white antialiased">
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
