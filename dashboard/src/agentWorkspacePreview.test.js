import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWorkspaceHtmlPreviewDocument,
  extractWorkspaceHtmlAssetRefs,
  isHtmlWorkspaceFile,
  isPythonWorkspaceFile,
  resolveWorkspaceAssetPath,
} from './agentWorkspacePreview.js';

test('workspace preview helpers detect supported file types', () => {
  assert.equal(isHtmlWorkspaceFile('src/index.html'), true);
  assert.equal(isHtmlWorkspaceFile('README.md'), false);
  assert.equal(isPythonWorkspaceFile('src/main.py'), true);
  assert.equal(isPythonWorkspaceFile('src/main.js'), false);
});

test('workspace preview helpers extract local asset refs and resolve them relative to the html file', () => {
  const refs = extractWorkspaceHtmlAssetRefs(`
    <html>
      <head>
        <link rel="stylesheet" href="./style.css">
      </head>
      <body>
        <script src="./script.js"></script>
        <script src="https://cdn.example.com/chart.js"></script>
      </body>
    </html>
  `);

  assert.deepEqual(refs, {
    styles: ['./style.css'],
    scripts: ['./script.js'],
  });
  assert.equal(resolveWorkspaceAssetPath('src/index.html', './style.css'), 'src/style.css');
  assert.equal(resolveWorkspaceAssetPath('src/index.html', '../shared.js'), 'shared.js');
});

test('workspace preview document builder inlines linked local css and js', () => {
  const html = buildWorkspaceHtmlPreviewDocument({
    htmlContent: '<html><head><link rel="stylesheet" href="./style.css"></head><body><script src="./script.js"></script></body></html>',
    styles: new Map([['./style.css', 'body { color: red; }']]),
    scripts: new Map([['./script.js', 'console.log("preview")']]),
  });

  assert.match(html, /<style data-inline-href="\.\/style\.css">/);
  assert.match(html, /body \{ color: red; \}/);
  assert.match(html, /console\.log\("preview"\)/);
  assert.doesNotMatch(html, /src="\.\/script\.js"/);
});