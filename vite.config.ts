import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Share-preview crawlers need an absolute og:image URL. VITE_SITE_URL wins;
  // on Vercel fall back to the production domain; otherwise stay root-relative.
  const siteUrl = (
    env.VITE_SITE_URL ||
    (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
  ).replace(/\/+$/, '');

  return {
    plugins: [
      react(),
      {
        name: 'site-url',
        transformIndexHtml: (html: string) => html.replaceAll('__SITE_URL__', siteUrl),
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
