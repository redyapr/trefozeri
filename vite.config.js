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
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'TREFOZERI S/R Dashboard',
        short_name: 'S/R Dashboard',
        description: 'Multi-timeframe support & resistance signals for XAUUSD and BTCUSD',
        theme_color: '#1b3a6b',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: base,
        icons: [
          { src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png' },
          { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png' },
          { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
