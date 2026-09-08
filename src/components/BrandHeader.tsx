import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface BrandHeaderProps {
  /** Page title shown next to the logo (hidden on small screens). */
  title?: string;
  /** Right-side actions (buttons, chips, user info). */
  children?: ReactNode;
}

/**
 * Solid brand-blue top bar with the white مياهثون lockup.
 * Used on every admin page so the identity is consistent across the app.
 */
export default function BrandHeader({ title, children }: BrandHeaderProps) {
  return (
    <header className="brand-header">
      <div className="brand-header__inner">
        <Link to="/host" className="brand-header__brand" aria-label="مياهثون — الصفحة الرئيسية">
          <img src="/brand/logo2.png" alt="مياهثون" className="brand-header__logo" />
          {title && (
            <>
              <span className="brand-header__divider" aria-hidden="true" />
              <span className="brand-header__title">{title}</span>
            </>
          )}
        </Link>
        {children && <div className="brand-header__actions">{children}</div>}
      </div>
    </header>
  );
}
