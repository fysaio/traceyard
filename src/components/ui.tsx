import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  FolderGit2,
  GitBranch,
  LoaderCircle,
  LogOut,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  User,
  X,
  type LucideIcon,
} from "lucide-react";

const icons = {
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  external: ArrowUpRight,
  agent: Bot,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  circle: Circle,
  alert: CircleAlert,
  passed: CircleCheck,
  failed: CircleX,
  copy: Copy,
  repository: FolderGit2,
  branch: GitBranch,
  spinner: LoaderCircle,
  "sign-out": LogOut,
  system: Monitor,
  dark: Moon,
  plus: Plus,
  refresh: RefreshCw,
  search: Search,
  settings: Settings,
  sliders: SlidersHorizontal,
  light: Sun,
  user: User,
  close: X,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof icons;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const Component = icons[name];
  return (
    <Component
      className={name === "spinner" ? "icon spin" : "icon"}
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
    />
  );
}

/** GitHub's mark, drawn inline so the brand icon matches the stroke icons in size. */
export function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="notice danger" role="alert">
      <Icon name="alert" />
      <span>{error instanceof Error ? error.message : "The request failed."}</span>
    </p>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p className="loading" role="status">
      <Icon name="spinner" />
      {label}
    </p>
  );
}

export type Tone = "pass" | "fail" | "warn" | "running" | "neutral";

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={"badge " + tone}>
      {tone === "running" ? <Icon name="spinner" size={12} /> : <span className="dot" />}
      {children}
    </span>
  );
}

export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="lede">{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Empty({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action && <div className="actions">{action}</div>}
    </div>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1600);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="btn"
      onClick={() =>
        void navigator.clipboard.writeText(value).then(
          () => setState("copied"),
          () => setState("failed"),
        )
      }
    >
      <Icon name={state === "copied" ? "check" : "copy"} />
      <span aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Select and copy" : label}
      </span>
    </button>
  );
}

export function Modal({
  title,
  children,
  close,
  footer,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  footer?: ReactNode;
  wide?: boolean;
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
      className={"dialog" + (wide ? " wide" : "")}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const box = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < box.left ||
          e.clientX > box.right ||
          e.clientY < box.top ||
          e.clientY > box.bottom
        )
          close();
      }}
    >
      <div className="dialog-head">
        <h2 id={id}>{title}</h2>
        <button type="button" className="btn icon ghost" aria-label="Close dialog" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-foot">{footer}</div>}
    </dialog>
  );
}

export const shortSha = (sha: string | null | undefined, length = 7) =>
  sha ? sha.slice(0, length) : null;

export const formatTime = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "";
