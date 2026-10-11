import { toast, type ExternalToast } from "sonner";

/** How long a toast stays (tokens.md "toast": 3.2 s). The amber countdown bar in globals.css drains over the same time (`--toast-life`). */
export const TOAST_LIFE_MS = 3200;

export type ToastTone = "success" | "info" | "warn" | "error";

/** Label of the undo action; `<Toaster>` sets it from the messages (`shell.toast.undo`) so the helper needs no React. */
let undoLabel = "Undo";
export function setToastUndoLabel(label: string): void {
  undoLabel = label;
}

export interface ToastOptions {
  id?: string | number;
  /** Milliseconds; also sets the countdown bar. Default `TOAST_LIFE_MS`. */
  duration?: number;
}

function withLife(options: ToastOptions): ExternalToast {
  const duration = options.duration ?? TOAST_LIFE_MS;
  return { ...(options.id === undefined ? {} : { id: options.id }), duration, style: { "--toast-life": `${duration}ms` } as React.CSSProperties };
}

/** One of the four tones: success / info / warn / error. */
export function toastTone(tone: ToastTone, message: string, options: ToastOptions = {}): string | number {
  const config = withLife(options);
  switch (tone) {
    case "success":
      return toast.success(message, config);
    case "info":
      return toast.info(message, config);
    case "warn":
      return toast.warning(message, config);
    case "error":
      return toast.error(message, config);
  }
}

export interface ToastUndoOptions extends ToastOptions {
  tone?: ToastTone;
  /** Overrides the translated "Undo". */
  label?: string;
}

/**
 * A toast with an "Undo" action (green, at the end of the row). `onUndo` runs when it is pressed; the toast closes
 * with it. For reversible actions such as ignore / move / delete, where the change has already been made.
 */
export function toastUndo(message: string, onUndo: () => void | Promise<void>, options: ToastUndoOptions = {}): string | number {
  const { tone = "success", label = undoLabel, ...rest } = options;
  const config: ExternalToast = {
    ...withLife(rest),
    action: {
      label,
      onClick: () => {
        void onUndo();
      },
    },
  };
  switch (tone) {
    case "success":
      return toast.success(message, config);
    case "info":
      return toast.info(message, config);
    case "warn":
      return toast.warning(message, config);
    case "error":
      return toast.error(message, config);
  }
}
