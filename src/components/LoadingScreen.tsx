import BrandHeader from './BrandHeader';

/** Full-page loading state with the brand header and a spinner. */
export default function LoadingScreen({ message = 'جاري التحميل...' }: { message?: string }) {
  return (
    <div className="app-shell">
      <BrandHeader />
      <div className="loading-screen" role="status" aria-live="polite">
        <div className="spinner" />
        <div>{message}</div>
      </div>
    </div>
  );
}
