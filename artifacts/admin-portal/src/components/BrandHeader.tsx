export function BrandHeader({ subtitle }: { subtitle?: string }) {
  return (
    <header className="bg-brand-navy text-white border-b-4 border-brand-gold">
      <div className="max-w-3xl mx-auto px-6 py-6 flex items-center gap-4">
        <img
          src={`${import.meta.env.BASE_URL}logo-256.png`}
          alt="Williams Council Security Group"
          className="w-14 h-14 shrink-0 rounded-md object-contain"
        />
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
