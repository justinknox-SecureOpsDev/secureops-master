import { useId, useRef, useState } from "react";
import { Upload, CheckCircle2, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadFile, type UploadedFile } from "@/lib/upload";

type Props = {
  label: string;
  accept?: string;
  value: UploadedFile | null;
  onChange: (f: UploadedFile | null) => void;
  required?: boolean;
  /** Override the default (authenticated) upload function. Pass `uploadFileAnon`
   *  on public pages (Apply / Onboard / Amend) that have no auth token. */
  uploadFn?: (file: File) => Promise<UploadedFile>;
  /** External validation error (e.g. "Please upload your Form I-9"). Rendered
   *  with role="alert" and wired to the trigger via aria-describedby so
   *  screen readers announce it. */
  error?: string;
  /** When set, hints mobile browsers to open the camera directly. Use
   *  "environment" for the rear camera (e.g. photo-capture questions). */
  capture?: boolean | "user" | "environment";
};

export function FileUploadField({ label, accept, value, onChange, required, uploadFn, error, capture }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const doUpload = uploadFn ?? uploadFile;

  const labelId = useId();
  const statusId = useId();
  const errorId = useId();
  const uploadErrorId = useId();

  async function pick(file: File) {
    setBusy(true);
    setUploadError(null);
    try {
      const result = await doUpload(file);
      onChange(result);
      // Return focus to the trigger so keyboard users land back at the
      // control after the picker closes.
      setTimeout(() => triggerRef.current?.focus(), 0);
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const describedBy = [
    value ? statusId : null,
    error ? errorId : null,
    uploadError ? uploadErrorId : null,
  ].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1">
      <div id={labelId} className="text-xs uppercase font-semibold text-foreground/80">
        {label}
        {required && <span className="text-destructive ml-0.5" aria-hidden="true">*</span>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        capture={capture}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) pick(f);
          e.target.value = "";
        }}
      />
      {value ? (
        <div className="flex items-center gap-2 p-2 bg-accent/40 border border-accent rounded text-sm">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
          <span id={statusId} className="truncate flex-1">
            <span className="sr-only">Selected file: </span>{value.name}
          </span>
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setTimeout(() => triggerRef.current?.focus(), 0);
            }}
            className="text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
            aria-label={`Remove ${value.name}`}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      ) : (
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="w-full justify-start"
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
        >
          {busy
            ? <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
            : <Upload className="w-4 h-4 mr-2" aria-hidden="true" />}
          {busy ? "Uploading…" : "Choose file"}
        </Button>
      )}
      {error && (
        <div id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </div>
      )}
      {uploadError && (
        <div id={uploadErrorId} role="alert" className="text-xs text-destructive">
          {uploadError}
        </div>
      )}
    </div>
  );
}

export function MultiFileUploadField({
  label, accept, value, onChange, required, uploadFn, error,
}: {
  label: string;
  accept?: string;
  value: UploadedFile[];
  onChange: (v: UploadedFile[]) => void;
  required?: boolean;
  uploadFn?: (file: File) => Promise<UploadedFile>;
  error?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const doUpload = uploadFn ?? uploadFile;

  const labelId = useId();
  const listId = useId();
  const errorId = useId();
  const uploadErrorId = useId();

  async function pickMany(files: FileList) {
    setBusy(true);
    setUploadError(null);
    try {
      const arr: UploadedFile[] = [];
      for (const f of Array.from(files)) {
        arr.push(await doUpload(f));
      }
      onChange([...value, ...arr]);
      setTimeout(() => triggerRef.current?.focus(), 0);
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const describedBy = [
    value.length > 0 ? listId : null,
    error ? errorId : null,
    uploadError ? uploadErrorId : null,
  ].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1">
      <div id={labelId} className="text-xs uppercase font-semibold text-foreground/80">
        {label}
        {required && <span className="text-destructive ml-0.5" aria-hidden="true">*</span>}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          if (e.target.files?.length) pickMany(e.target.files);
          e.target.value = "";
        }}
      />
      <ul id={listId} className="space-y-1" aria-label={`Selected files for ${label}`}>
        {value.map((f, i) => (
          <li key={i} className="flex items-center gap-2 p-2 bg-accent/40 border border-accent rounded text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
            <span className="truncate flex-1">{f.name}</span>
            <button
              type="button"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded"
              aria-label={`Remove ${f.name}`}
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <Button
        ref={triggerRef}
        type="button" variant="outline" disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="w-full justify-start"
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
      >
        {busy
          ? <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
          : <Upload className="w-4 h-4 mr-2" aria-hidden="true" />}
        {busy ? "Uploading…" : value.length ? "Add more" : "Choose files"}
      </Button>
      {error && (
        <div id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </div>
      )}
      {uploadError && (
        <div id={uploadErrorId} role="alert" className="text-xs text-destructive">
          {uploadError}
        </div>
      )}
    </div>
  );
}
