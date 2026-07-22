import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const targetServer = env.VITE_QUEPASA_SERVER_URL || 'https://apiwhatsapp.v4saman.com';

  return {
    plugins: [react()],
    server: {
      port: 3000,
      host: true,
      proxy: {
        '/quepasa-proxy': {
          target: targetServer,
          changeOrigin: true,
          secure: false,
          rewrite: (path) => path.replace(/^\/quepasa-proxy/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              const instanceToken = req.headers && req.headers['x-quepasa-token'];
              if (instanceToken) {
                // Server-side rewrite: replace /v3/bot/self/ placeholder with actual token
                if (proxyReq.path.includes('/v3/bot/self/')) {
                  proxyReq.path = proxyReq.path.replace('/v3/bot/self/', `/v3/bot/${encodeURIComponent(instanceToken)}/`);
                }

                // Server-side rewrite: append ?token={instanceToken} to target API URL
                if (!proxyReq.path.includes('token=')) {
                  const sep = proxyReq.path.includes('?') ? '&' : '?';
                  proxyReq.path += `${sep}token=${encodeURIComponent(instanceToken)}`;
                }
              }
            });
          }
        }
      }
    }
  };
});
