import { useRef, useState } from "react";
import { Upload, CheckCircle2, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uploadFile, type UploadedFile } from "@/lib/upload";

type Props = {
  label: string;
  accept?: string;
  value: UploadedFile | null;
  onChange: (f: UploadedFile | null) => void;
  required?: boolean;
};

export function FileUploadField({ label, accept, value, onChange, required }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File) {
    setBusy(true);
    setError(null);
    try {
      const result = await uploadFile(file);
      onChange(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="text-xs uppercase font-semibold text-foreground/80">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) pick(f);
          e.target.value = "";
        }}
      />
      {value ? (
        <div className="flex items-center gap-2 p-2 bg-accent/40 border border-accent rounded text-sm">
          <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
          <span className="truncate flex-1">{value.name}</span>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-muted-foreground hover:text-destructive"
            aria-label="Remove"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
          className="w-full justify-start"
        >
          {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
          {busy ? "Uploading…" : "Choose file"}
        </Button>
      )}
      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}

export function MultiFileUploadField({
  label, accept, value, onChange, required,
}: {
  label: string;
  accept?: string;
  value: UploadedFile[];
  onChange: (v: UploadedFile[]) => void;
  required?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickMany(files: FileList) {
    setBusy(true);
    setError(null);
    try {
      const arr: UploadedFile[] = [];
      for (const f of Array.from(files)) {
        arr.push(await uploadFile(f));
      }
      onChange([...value, ...arr]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="text-xs uppercase font-semibold text-foreground/80">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </div>
      <input
        ref={inputRef} type="file" multiple accept={accept} className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) pickMany(e.target.files);
          e.target.value = "";
        }}
      />
      <div className="space-y-1">
        {value.map((f, i) => (
          <div key={i} className="flex items-center gap-2 p-2 bg-accent/40 border border-accent rounded text-sm">
            <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
            <span className="truncate flex-1">{f.name}</span>
            <button
              type="button"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
              className="text-muted-foreground hover:text-destructive"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
      <Button
        type="button" variant="outline" disabled={busy}
        onClick={() => inputRef.current?.click()}
        className="w-full justify-start"
      >
        {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
        {busy ? "Uploading…" : value.length ? "Add more" : "Choose files"}
      </Button>
      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}
