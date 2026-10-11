import type { Metadata } from "next";
import { InstallGuide } from "@/components/pwa/InstallGuide";

// Public page (no sign-in needed) that walks anyone through putting BusyBee on
// their phone, tablet or computer as an app. Share the link:
//   https://busybee-xi.vercel.app/install
export const metadata: Metadata = {
  title: "Install BusyBee",
  description: "Put BusyBee on your phone or tablet as an app - no app store needed.",
};

export default function InstallPage() {
  return <InstallGuide />;
}
