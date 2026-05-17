import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export type VisibleSections = {
  license: boolean;
  experience: boolean;
  skills: boolean;
  uniform: boolean;
  trainingCerts: boolean;
  documents: boolean;
};

export const DEFAULT_SECTIONS: VisibleSections = {
  license: true,
  experience: true,
  skills: true,
  uniform: true,
  trainingCerts: true,
  documents: true,
};

export const SECTION_LABELS: Array<[keyof VisibleSections, string, string]> = [
  ["license", "TX security license", "License number, level, expiry, and any extra licenses on record."],
  ["experience", "Experience", "Years of experience and the prior-experience narrative."],
  ["skills", "Skills & qualifications", "The officer's skills tag list."],
  ["uniform", "Uniform sizes", "Shirt, trousers, jacket, boots — useful when prepping kit."],
  ["trainingCerts", "Training certificates", "Filenames of training certs on file (no downloads)."],
  ["documents", "Documents on file", "Filenames of CV, license scan, passport, right-to-work, pay stub (no downloads)."],
];

export function EmployeeShareSectionsField({
  value, onChange, disabled, label = "Sections visible to recipient",
}: {
  value: VisibleSections;
  onChange: (next: VisibleSections) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="rounded-md border p-3 space-y-2.5">
        {SECTION_LABELS.map(([key, lbl, hint]) => (
          <label key={key} className="flex items-start gap-3 cursor-pointer">
            <Checkbox
              checked={value[key]}
              onCheckedChange={(v) => onChange({ ...value, [key]: v === true })}
              disabled={disabled}
              className="mt-0.5"
            />
            <div className="flex-1">
              <div className="text-sm font-medium brand-navy">{lbl}</div>
              <div className="text-xs text-muted-foreground leading-snug">{hint}</div>
            </div>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Name, photo, and right-to-work status are always shown.
      </p>
    </div>
  );
}
