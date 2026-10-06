export const BRAND_NAME = 'هاكثون الابتكار';
export const BRAND_AWARD = 'جائزة مايدة محي الدين ناظر للابتكار';

/** Full logo (white + gold) — only for maroon backgrounds. */
export function BrandLogo({ className }: { className?: string }) {
  return <img src="/brand/logo.png" alt={`${BRAND_NAME} — ${BRAND_AWARD}`} className={className} />;
}

/** Compact gold bulb mark + two-line wordmark for maroon top bars. */
export default function BrandLockup() {
  return (
    <span className="brand-lockup">
      <img src="/brand/mark.png" alt="" aria-hidden="true" className="brand-lockup__mark" />
      <span className="brand-lockup__text">
        <span className="brand-lockup__name">{BRAND_NAME}</span>
        <span className="brand-lockup__award">{BRAND_AWARD}</span>
      </span>
    </span>
  );
}
