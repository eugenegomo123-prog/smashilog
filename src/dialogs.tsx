import { useEffect, useState } from "react";

// In-app replacements for the browser's built-in alert() / confirm() /
// prompt() boxes, styled with the same .modal-overlay / .modal-card look as
// ParticipantSession.tsx's StatusPopup. The browser ones can't be themed,
// look different on every phone, and (for prompt) can't validate input or
// stay open to show an error.
//
// Used the same way as the originals, just awaited:
//
//   if (!(await confirmDialog("Delete this?", { confirmLabel: "Delete", danger: true }))) return;
//   const name = await promptDialog("New name:");   // null = cancelled
//   await alertDialog("Saved.");
//
// <DialogHost /> (mounted once in App.tsx) is what actually draws them. If it
// somehow isn't mounted, each function falls back to the browser's own box so
// a button can never end up waiting forever on a dialog nobody can see.

type DialogRequest =
  | { kind: "alert"; message: string; resolve: () => void }
  | {
      kind: "confirm";
      message: string;
      confirmLabel: string;
      danger: boolean;
      resolve: (ok: boolean) => void;
    }
  | {
      kind: "prompt";
      message: string;
      confirmLabel: string;
      placeholder: string;
      validate?: (value: string) => string | null;
      resolve: (value: string | null) => void;
    };

let enqueue: ((request: DialogRequest) => void) | null = null;

export function alertDialog(message: string): Promise<void> {
  return new Promise((resolve) => {
    if (!enqueue) {
      window.alert(message);
      resolve();
      return;
    }
    enqueue({ kind: "alert", message, resolve });
  });
}

// Resolves true on the confirm button, false on Cancel / Escape / tapping
// outside the box. `danger` styles the confirm button red and makes Cancel
// the default-focused button, so a stray Enter press can't delete anything.
export function confirmDialog(
  message: string,
  options: { confirmLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!enqueue) {
      resolve(window.confirm(message));
      return;
    }
    enqueue({
      kind: "confirm",
      message,
      confirmLabel: options.confirmLabel ?? "OK",
      danger: options.danger ?? false,
      resolve,
    });
  });
}

// Resolves the typed text, or null if cancelled. `validate` returns an error
// message to show under the box (and keep it open), or null when the text is
// fine -- unlike the browser's prompt(), which always had to close first.
export function promptDialog(
  message: string,
  options: { confirmLabel?: string; placeholder?: string; validate?: (value: string) => string | null } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    if (!enqueue) {
      resolve(window.prompt(message));
      return;
    }
    enqueue({
      kind: "prompt",
      message,
      confirmLabel: options.confirmLabel ?? "OK",
      placeholder: options.placeholder ?? "",
      validate: options.validate,
      resolve,
    });
  });
}

let nextDialogId = 1;

// Draws whichever dialog is first in line (if two are asked for back to
// back, the second appears once the first is answered).
export function DialogHost() {
  const [queue, setQueue] = useState<{ id: number; request: DialogRequest }[]>([]);

  useEffect(() => {
    enqueue = (request) => setQueue((q) => [...q, { id: nextDialogId++, request }]);
    return () => {
      enqueue = null;
    };
  }, []);

  const current = queue[0];
  if (!current) return null;
  // key={id} so two prompts in a row each start with an empty box.
  return (
    <DialogCard key={current.id} request={current.request} onDone={() => setQueue((q) => q.slice(1))} />
  );
}

function DialogCard({ request, onDone }: { request: DialogRequest; onDone: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  function cancel() {
    if (request.kind === "alert") request.resolve();
    else if (request.kind === "confirm") request.resolve(false);
    else request.resolve(null);
    onDone();
  }

  function accept() {
    if (request.kind === "prompt") {
      const problem = request.validate?.(value) ?? null;
      if (problem) {
        setError(problem);
        return;
      }
      request.resolve(value);
    } else if (request.kind === "confirm") {
      request.resolve(true);
    } else {
      request.resolve();
    }
    onDone();
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") cancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request]);

  const danger = request.kind === "confirm" && request.danger;
  const confirmLabel = request.kind === "alert" ? "OK" : request.confirmLabel;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <form
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-message"
        onSubmit={(e) => {
          e.preventDefault();
          accept();
        }}
      >
        <p id="dialog-message" className="dialog-message">
          {request.message}
        </p>
        {request.kind === "prompt" && (
          <>
            <input
              className="dialog-input"
              type="text"
              autoFocus
              value={value}
              placeholder={request.placeholder}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => {
                setValue(e.target.value);
                setError("");
              }}
            />
            {error && <div className="error-text dialog-error">{error}</div>}
          </>
        )}
        <div className="dialog-actions">
          {request.kind !== "alert" && (
            <button type="button" className="btn" autoFocus={danger} onClick={cancel}>
              Cancel
            </button>
          )}
          <button
            type="submit"
            className={`btn ${danger ? "danger" : "primary"}`}
            autoFocus={request.kind === "alert" || (request.kind === "confirm" && !danger)}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
