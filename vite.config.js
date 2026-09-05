import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Local dev serves this app from the domain root, but the GitHub Pages deploy
// (.github/workflows/deploy.yml) is a project site — https://redyapr.github.io/
// trefozeri/ — so it needs every asset path prefixed with the repo name instead. The
// workflow sets GH_PAGES=true only for that build; every other build keeps root-basing.
const base = process.env.GH_PAGES ? '/trefozeri/' : '/'

export default defineConfig({
  // Service workers require an absolute scope; relative './' basing (harmless for a
  // plain static site) doesn't play well with that, so `base` is always an absolute
  // path — just one that varies by target above.
  base,
  build: {
    target: 'es2020',
    rollupOptions: {
      // 2026-09-05 multi-page revamp: index.html is now a landing page (Home), with the
      // live dashboard split out to its own mapping/ and performance/ pages, alongside
      // the existing id/ (Indonesian SEO landing) and api/ (public data API docs) —
      // separate Vite entries so every one of them gets the same base-path rewriting
      // and asset bundling as the app itself instead of being served unprocessed.
      input: {
        main: 'index.html',
        mapping: 'mapping/index.html',
        performance: 'performance/index.html',
        id: 'id/index.html',
        api: 'api/index.html',
      },
    },
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'TREFOZERI S/R Dashboard',
        short_name: 'S/R Dashboard',
        description: 'Multi-timeframe support & resistance signals for XAUUSD and BTCUSD',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        // Opens straight to the live dashboard (Mapping & Signal), not the Home landing
        // page — an installed PWA icon should launch into the actual app, not a marketing
        // page with a link to click through every time.
        start_url: `${base}mapping/`,
        icons: [
          { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png' },
          { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
