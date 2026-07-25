import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  // GitHub Pages serves this as a project site at /webtts-inflect/, not
  // the domain root, so every asset path needs that prefix baked in.
  base: '/webtts-inflect/',
  plugins: [tailwindcss(), foldkit({ devToolsMcpPort: 9988 })],
  optimizeDeps: {
    entries: ['src/entry.ts'],
  },
})
