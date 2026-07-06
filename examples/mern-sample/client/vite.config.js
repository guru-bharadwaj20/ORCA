import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// host: true binds to 0.0.0.0 so the dev server is reachable from outside the container.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
});
