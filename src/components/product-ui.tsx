import { useEffect, useId, useRef, type ReactNode } from "react";
export function Icon({ name }: { name: string }) {
  return <i className={"fa-solid fa-" + name} aria-hidden="true" />;
}
export function ErrorMessage({ error }: { error: unknown }) {
  return error ? (
    <p className="request-error" role="alert">
      {error instanceof Error ? error.message : "The request failed."}
    </p>
  ) : null;
}
export function Modal({
  title,
  children,
  close,
  menu = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  menu?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>("input,textarea")?.focus();
    return () => {
      dialog?.close();
      trigger?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={"product-dialog " + (menu ? "product-menu" : "")}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const box = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < box.left ||
            e.clientX > box.right ||
            e.clientY < box.top ||
            e.clientY > box.bottom
          )
            close();
        }
      }}
    >
      <div className="dialog-heading">
        <h2 id={id}>{title}</h2>
        <button type="button" className="btn icon-only" aria-label="Close dialog" onClick={close}>
          <Icon name="xmark" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
