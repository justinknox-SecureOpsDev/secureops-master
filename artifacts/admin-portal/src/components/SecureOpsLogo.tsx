/**
 * SecureOps Command — platform brand emblem.
 *
 * This is the PLATFORM mark shown on the shared sign-in screens (web admin
 * portal + mobile app). Every white-label tenant signs in through the same
 * SecureOps Command screen; their own company branding takes over only AFTER
 * authentication. So this emblem is intentionally fixed to the platform
 * SecureOps Command seal and is NOT driven by the per-tenant __BRAND__ config.
 *
 * Rendered from the raster emblem asset (public/logo-256.png) so the detailed
 * gold eagle seal stays faithful at any size. The mobile app renders the
 * identical asset via the react-native <Image> component.
 */
export function SecureOpsLogo({
  size = 96,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src={`${import.meta.env.BASE_URL}logo-256.png`}
      width={size}
      height={size}
      className={className}
      alt="SecureOps Command"
      style={{ objectFit: "contain" }}
    />
  );
}
