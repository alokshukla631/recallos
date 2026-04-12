import { useState, useEffect, useCallback, createContext, useContext } from "react";
import "./Toast.css";

type ToastType = "success" | "error" | "info" | "warning";

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue>({
  toast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, type: ToastType = "info", duration = 3000) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, type, duration }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="toast-container">
        {toasts.map((t) => (
          <ToastItem key={t.id} item={t} onDone={() => removeToast(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ item, onDone }: { item: ToastItem; onDone: () => void }) {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(onDone, 300);
    }, item.duration);
    return () => clearTimeout(timer);
  }, [item.duration, onDone]);

  return (
    <div className={`toast toast-${item.type}${exiting ? " toast-exit" : ""}`} onClick={() => { setExiting(true); setTimeout(onDone, 300); }}>
      <span className="toast-icon">
        {item.type === "success" && "\u2713"}
        {item.type === "error" && "\u2717"}
        {item.type === "warning" && "\u26A0"}
        {item.type === "info" && "\u2139"}
      </span>
      <span className="toast-message">{item.message}</span>
    </div>
  );
}
