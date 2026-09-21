"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { sendJSON } from "@/lib/api";

type Notification = {
  id: string;
  title: string;
  message: string | null;
  read: boolean;
  created_at: string;
  task_id: string | null;
};

// In-app notification centre (checklist #34), in the navigation bar on every
// page. Clicking a notification marks it read and, if it is about a task,
// opens that task - on the Tasks page directly, from anywhere else by going
// there.
export const OPEN_TASK_EVENT = "bb-open-task";

export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const box = useRef<HTMLDivElement>(null);

  const onOpenTask = (taskId: string) => {
    if (pathname === "/dashboard") window.dispatchEvent(new CustomEvent(OPEN_TASK_EVENT, { detail: taskId }));
    else router.push(`/dashboard?task=${taskId}`);
  };

  // Close when clicking elsewhere or pressing Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const load = async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setItems(Array.isArray(data) ? data : []);
      }
    } catch {
      /* keep what is on screen */
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const unread = items.filter((n) => !n.read).length;

  const click = async (n: Notification) => {
    if (!n.read) {
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      sendJSON("/api/notifications", "PATCH", { id: n.id }).catch(() => {});
    }
    if (n.task_id) {
      onOpenTask(n.task_id);
      setOpen(false);
    }
  };

  const markAll = async () => {
    setItems((prev) => prev.map((x) => ({ ...x, read: true })));
    sendJSON("/api/notifications", "PATCH", { all: true }).catch(load);
  };

  return (
    <div className="relative shrink-0" ref={box}>
      <button
        onClick={() => {
          setOpen(!open);
          if (!open) load();
        }}
        className="px-3 py-2 bg-slate-800 hover:bg-slate-700 rounded text-sm min-h-[40px]"
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
      >
        🔔{" "}
        {unread > 0 && <span className="ml-1 bg-red-600 text-white text-xs rounded-full px-1.5">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-[min(22rem,calc(100vw-1.5rem))] bg-slate-800 border border-slate-700 rounded shadow-lg z-50" role="dialog" aria-label="Notifications">
          <div className="flex justify-between items-center px-3 py-2 border-b border-slate-700">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && (
              <button onClick={markAll} className="text-xs text-blue-400 hover:underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <p className="p-4 text-slate-400 text-sm">No notifications</p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => click(n)}
                  className={`block w-full text-left p-3 border-b border-slate-700 text-sm hover:bg-slate-700 ${
                    n.read ? "text-slate-500" : "text-slate-200"
                  }`}
                >
                  <p className={n.read ? "" : "font-semibold"}>{n.title}</p>
                  {n.message && <p className="text-xs mt-0.5 text-slate-400">{n.message}</p>}
                  <p className="text-xs text-slate-500 mt-1">{new Date(n.created_at).toLocaleString()}</p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
