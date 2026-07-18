/**
 * SecureOps Command brand mark — the gold eagle seal, rendered from the raster
 * emblem asset so the detailed seal stays faithful. Sized by the caller via
 * `className` (e.g. apex-brand__mark / apex-product__mark). The asset lives in
 * this site's public dir and is resolved through Vite's BASE_URL so it works
 * under any deploy base.
 */
const EMBLEM_SRC = `${import.meta.env.BASE_URL}logo-emblem.png`;

export function ShieldLogo({ className = "" }: { className?: string }) {
  return (
    <img
      src={EMBLEM_SRC}
      className={className}
      alt="SecureOps Command"
      width={42}
      height={42}
      style={{ objectFit: "contain" }}
    />
  );
}
