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
  const cspMeta = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; base-uri \'none\'; form-action \'none\'; connect-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\' \'unsafe-eval\'; font-src data: blob:; media-src data: blob:; frame-ancestors \'none\'">';

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

  return documentHtml;
}