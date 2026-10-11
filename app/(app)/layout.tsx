import { AuthProvider } from "@/components/auth/AuthProvider";
import { AppNav } from "@/components/layout/AppNav";
import { DeskGate } from "@/components/auth/DeskGate";
import { AppNudge } from "@/components/pwa/AppNudge";
import { PullToRefresh } from "@/components/pwa/PullToRefresh";

// Every signed-in page shares the login guard and the navigation (a tab bar
// at the bottom on phones - see AppNav).
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <div className="flex flex-col min-h-screen">
        <AppNav />
        <AppNudge />
        <PullToRefresh />
        <main className="flex-1 tabbar-space">
          <DeskGate>{children}</DeskGate>
        </main>
      </div>
    </AuthProvider>
  );
}
