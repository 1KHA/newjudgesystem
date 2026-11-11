import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// WhatsApp, Facebook, X, Telegram, iMessage and browsers cache these images by URL.
// index.html links them with ?v=<content hash>, so every new version of a file gets
// a new URL and shows up straight away instead of after those caches expire.
const VERSIONED_PUBLIC_FILES = /="(__SITE_URL__)?\/(og-image\.png|apple-touch-icon\.png|favicon\.svg|favicon\.ico)"/g;
const contentHash = (file: string) =>
  createHash('sha256').update(readFileSync(path.resolve(__dirname, 'public', file))).digest('hex').slice(0, 10);

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Share-preview crawlers need an absolute image URL that serves this build's files.
  // Vercel preview deploys use their own URL: pointing them at production would let a
  // shared preview link cache the old production image under the new ?v= URL.
  // Production uses VITE_SITE_URL, else the Vercel production domain; local builds stay root-relative.
  const siteUrl = (
    env.VERCEL_ENV === 'preview' && env.VERCEL_URL
      ? `https://${env.VERCEL_URL}`
      : env.VITE_SITE_URL ||
        (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
  ).replace(/\/+$/, '');

  return {
    plugins: [
      react(),
      {
        name: 'share-meta',
        transformIndexHtml: (html: string) =>
          html
            .replace(VERSIONED_PUBLIC_FILES, (_m, site = '', file: string) => `="${site}/${file}?v=${contentHash(file)}"`)
            .replaceAll('__SITE_URL__', siteUrl),
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@components': path.resolve(__dirname, './src/components'),
        '@pages': path.resolve(__dirname, './src/pages'),
        '@hooks': path.resolve(__dirname, './src/hooks'),
        '@lib': path.resolve(__dirname, './src/lib'),
      },
    },
    server: {
      port: 3000,
      host: true,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
