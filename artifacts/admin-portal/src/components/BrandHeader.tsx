import { ShieldCheck } from "lucide-react";

export function BrandHeader({ subtitle }: { subtitle?: string }) {
  return (
    <header className="bg-brand-navy text-white border-b-4 border-brand-gold">
      <div className="max-w-3xl mx-auto px-6 py-6 flex items-center gap-4">
        <ShieldCheck className="w-10 h-10 brand-gold shrink-0" />
        <div>
          <div className="brand-wordmark text-lg leading-tight">Williams Council</div>
          <div className="brand-wordmark text-lg brand-gold leading-tight">Security Group</div>
          {subtitle && (
            <div className="text-[11px] uppercase tracking-widest opacity-70 mt-0.5">
              {subtitle}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
