const _b = () => (window as any).__BRAND__;

export function BrandHeader({ subtitle }: { subtitle?: string }) {
  const b = _b();
  return (
    <header className="bg-brand-navy text-white border-b-4 border-brand-gold">
      <div className="max-w-3xl mx-auto px-6 py-6 flex items-center gap-4">
        <img
          src={b?.logoDataUrl || `${import.meta.env.BASE_URL}logo-256.png`}
          alt={b?.companyName ?? "Williams Council Security Group"}
          className="w-14 h-14 shrink-0 rounded-md object-contain"
        />
        <div>
          <div className="brand-wordmark text-lg leading-tight">{b?.companyName ?? "Williams Council Security Group"}</div>
          {subtitle && (
            <div className="text-[11px] uppercase tracking-widest opacity-70 mt-0.5">
              {subtitle}
            </div>
          )}
          {b?.companyLicense && (
            <div className="text-[11px] opacity-60 mt-0.5">{b.companyLicense}</div>
          )}
        </div>
      </div>
    </header>
  );
}
