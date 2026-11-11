export const BRAND_NAME = 'هاكثون الطفولة';
export const BRAND_ORG = 'جمعية إنماء لرعاية الطفولة';

/** Full logo, cream wordmark — only for navy backgrounds (auth and judge pages). */
export function BrandLogo({ className }: { className?: string }) {
  return <img src="/brand/logo-light.svg" alt={`${BRAND_NAME} — ${BRAND_ORG}`} className={className} />;
}

/** The same logo sized for navy top bars. */
export default function BrandLockup() {
  return (
    <span className="brand-lockup">
      <img src="/brand/logo-light.svg" alt={BRAND_NAME} className="brand-lockup__logo" />
    </span>
  );
}
