import { defineConfig, loadEnv } from 'vite'
import { compression } from 'vite-plugin-compression2'

/**
 * Add fetchpriority hints to critical resources in production builds.
 * - CSS: fetchpriority="high" (render-blocking, needed ASAP)
 * - Entry JS modulepreload: fetchpriority="high"
 * - Non-critical chunk preloads: fetchpriority="low"
 */
function resourceHintsPlugin() {
  return {
    name: 'resource-hints',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (ctx.server) return html; // Dev only

        // Add fetchpriority="high" to the main CSS link
        html = html.replace(
          /(<link\s+rel="stylesheet"[^>]*href="[^"]*index-[^"]*\.css")/g,
          '$1 fetchpriority="high"'
        );

        // Add fetchpriority="high" to the entry module script
        html = html.replace(
          /(<script\s+type="module"[^>]*src="[^"]*index-[^"]*\.js")/g,
          '$1 fetchpriority="high"'
        );

        // Add fetchpriority="low" to non-entry modulepreload links (chunks)
        html = html.replace(
          /(<link\s+rel="modulepreload"[^>]*href="[^"]*(?:rooms|chat|auth)-[^"]*\.js")/g,
          '$1 fetchpriority="low"'
        );

        return html;
      },
    },
  };
}

/** Inject CSP meta tag only in production builds (dev needs inline scripts for HMR). */
function cspPlugin() {
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
    "font-src 'self' https://cdn.jsdelivr.net",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  return {
    name: 'inject-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        // Only inject in production build
        if (ctx.server) return html;
        return html.replace(
          '<!-- CSP injected at build time by Vite (see vite.config.js cspPlugin) -->',
          `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
        );
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const dashboardPort = env.DASHBOARD_PORT || process.env.DASHBOARD_PORT || '3000'
  const controlPort = env.CONTROL_PORT || process.env.CONTROL_PORT || '3002'

  // Build allowedHosts from NGROK_DOMAIN if set (supports ngrok tunneling)
  const ngrokDomain = env.NGROK_DOMAIN || process.env.NGROK_DOMAIN || ''
  const allowedHosts = ngrokDomain ? [ngrokDomain] : []

  return {
    envDir: '..',
    server: {
      port: Number(dashboardPort),
      allowedHosts,
      proxy: {
        '/v1': {
          target: `http://localhost:${controlPort}`,
          changeOrigin: true,
        },
        '/health': {
          target: `http://localhost:${controlPort}`,
          changeOrigin: true,
        },
        '/manager': {
          target: `http://localhost:${controlPort}`,
          changeOrigin: true,
          ws: true,
          rewrite: (path) => path.replace(/^\/manager/, ''),
        },
        '/api': {
          target: `http://localhost:${controlPort}`,
          changeOrigin: true,
        },
      },
    },
    plugins: [
      // Inject CSP only in production (dev needs inline scripts for Vite HMR)
      cspPlugin(),
      // Add fetchpriority hints to critical resources
      resourceHintsPlugin(),
      // Pre-compress static assets at build time (Brotli level 11 — max compression)
      compression({ algorithm: 'brotliCompress', exclude: [/\.(png|jpg|jpeg|gif|webp|avif)$/i] }),
      // Also generate gzip for clients that don't support Brotli
      compression({ algorithm: 'gzip', exclude: [/\.(png|jpg|jpeg|gif|webp|avif)$/i] }),
    ],
    build: {
      // Enable CSS minification (esbuild is default, already good)
      cssMinify: true,
      // Target modern browsers for smaller output
      target: 'es2022',
      // Manual chunk splitting for better caching
      rollupOptions: {
        output: {
          manualChunks: {
            // Rooms + Agent Room feature (merged — tightly coupled via cross-imports)
            'rooms': [
              './src/roomsUI.js',
              './src/roomsList.js',
              './src/roomChat.js',
              './src/roomsUtils.js',
              './src/agentSocket.js',
              './src/agentWorkspace.js',
              './src/agentWorkspaceData.js',
              './src/agentWorkspacePreview.js',
              './src/agentConfigModal.js',
              './src/agentHandoffViz.js',
              './src/agentTokenUsage.js',
              './src/agentOrchestrationConfig.js',
              './src/agentTypingIndicator.js',
              './src/agentMemoryPanel.js',
            ],
            // Auth + API client — core but separable
            'auth': [
              './src/authClient.js',
              './src/authUI.js',
            ],
            // Chat features — main chat functionality
            'chat': [
              './src/chatApi.js',
              './src/chatStorage.js',
              './src/conversationManager.js',
              './src/messageRenderer.js',
              './src/markdownRenderer.js',
              './src/searchManager.js',
            ],
          },
        },
      },
    },
  }
})
