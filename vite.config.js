import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // Service workers require an absolute scope; relative './' basing (harmless for a
  // plain static site) doesn't play well with that, and this app is always served
  // from the domain root on Netlify anyway.
  base: '/',
  build: {
    target: 'es2020',
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'TREFOZERI S/R Dashboard',
        short_name: 'S/R Dashboard',
        description: 'Multi-timeframe support & resistance signals for XAU/USD and BTC/USD',
        theme_color: '#1b3a6b',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
})
