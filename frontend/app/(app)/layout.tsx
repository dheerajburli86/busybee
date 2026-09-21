import { AuthProvider } from "@/components/auth/AuthProvider";
import { AppNav } from "@/components/layout/AppNav";
import { DeskGate } from "@/components/auth/DeskGate";

// Every signed-in page shares the login guard and the navigation bar.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <div className="flex flex-col min-h-screen">
        <AppNav />
        <main className="flex-1">
          <DeskGate>{children}</DeskGate>
        </main>
      </div>
    </AuthProvider>
  );
}
