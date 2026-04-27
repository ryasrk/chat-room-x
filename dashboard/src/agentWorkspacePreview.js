const LOCAL_REF_PATTERN = /^(?:[a-z]+:|\/\/|#|data:|mailto:|tel:)/i;

export function isHtmlWorkspaceFile(path) {
  return /\.html?$/i.test(String(path || '').trim());
}

export function isPythonWorkspaceFile(path) {
  return /\.py$/i.test(String(path || '').trim());
}

export function isLocalWorkspaceAssetRef(ref) {
  const value = String(ref || '').trim();
  return Boolean(value) && !LOCAL_REF_PATTERN.test(value);
}

export function resolveWorkspaceAssetPath(filePath, assetRef) {
  if (!isLocalWorkspaceAssetRef(assetRef)) {
    return '';
  }

  const baseUrl = new URL(`https://workspace.local/${String(filePath || '').replace(/^\/+/, '')}`);
  return new URL(assetRef, baseUrl).pathname.replace(/^\/+/, '');
}

export function extractWorkspaceHtmlAssetRefs(htmlContent) {
  const content = String(htmlContent || '');
  const styles = [];
  const scripts = [];

  const linkPattern = /<link\b[^>]*rel=["'][^"']*stylesheet[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  const scriptPattern = /<script\b[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi;

  let match = null;
  while ((match = linkPattern.exec(content)) !== null) {
    const ref = String(match[1] || '').trim();
    if (isLocalWorkspaceAssetRef(ref) && !styles.includes(ref)) {
      styles.push(ref);
    }
  }

  while ((match = scriptPattern.exec(content)) !== null) {
    const ref = String(match[1] || '').trim();
    if (isLocalWorkspaceAssetRef(ref) && !scripts.includes(ref)) {
      scripts.push(ref);
    }
  }

  return { styles, scripts };
}

export function buildWorkspaceHtmlPreviewDocument({ htmlContent, styles = new Map(), scripts = new Map() }) {
  let documentHtml = String(htmlContent || '');
  const cspMeta = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'self\'; connect-src https: http:; img-src data: blob: https: http:; style-src \'unsafe-inline\' https://fonts.googleapis.com; style-src-elem \'unsafe-inline\' https://fonts.googleapis.com; script-src \'unsafe-inline\' \'unsafe-eval\' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com; font-src data: blob: https://fonts.gstatic.com; media-src data: blob: https: http:">';

  for (const [ref, content] of styles.entries()) {
    const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`<link\\b(?=[^>]*rel=["'][^"']*stylesheet[^"']*["'])(?=[^>]*href=["']${escapedRef}["'])[^>]*>`, 'gi');
    documentHtml = documentHtml.replace(pattern, `<style data-inline-href="${ref}">\n${String(content || '')}\n</style>`);
  }

  for (const [ref, content] of scripts.entries()) {
    const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`<script\\b([^>]*)src=["']${escapedRef}["']([^>]*)><\\/script>`, 'gi');
    documentHtml = documentHtml.replace(pattern, (_match, before = '', after = '') => `<script${before}${after}>\n${String(content || '')}\n<\/script>`);
  }

  if (!/Content-Security-Policy/i.test(documentHtml)) {
    documentHtml = documentHtml.replace(/<head([^>]*)>/i, `<head$1>${cspMeta}`);
  }

  if (!/<base\b/i.test(documentHtml)) {
    documentHtml = documentHtml.replace(/<head([^>]*)>/i, '<head$1><base target="_blank">');
  }

  // Fix hash-only anchor links: <base target="_blank"> causes #hash links to
  // open in a new tab instead of scrolling within the iframe.  This small
  // script intercepts clicks on hash-only hrefs and performs in-page navigation.
  const hashLinkFix = `<script data-preview-hashfix>
document.addEventListener('click', function(e) {
  var a = e.target.closest('a[href]');
  if (!a) return;
  var href = a.getAttribute('href');
  if (!href || href.charAt(0) !== '#') return;
  e.preventDefault();
  if (href.length > 1) {
    var target = document.getElementById(href.slice(1)) ||
                 document.querySelector('[name="' + CSS.escape(href.slice(1)) + '"]');
    if (target) target.scrollIntoView({ behavior: 'smooth' });
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});
<\/script>`;
  documentHtml = documentHtml.replace(/<\/body>/i, hashLinkFix + '</body>');

  return documentHtml;
}