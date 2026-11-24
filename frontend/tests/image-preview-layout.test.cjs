const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/lib/image-preview-layout.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const { imagePreviewLayout } = loaded.exports;
const image = { width: 1600, height: 1000 };
const viewport = ratio => ({ width: 741, height: 601, pixelRatio: ratio, left: 279.5, top: 83.25 });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

test('100% maps every original image pixel to a display pixel at standard and fractional display scales', () => {
  for (const ratio of [0.8, 1, 1.25, 1.5, 2]) {
    const result = imagePreviewLayout(image, viewport(ratio), 1);
    near(result.width * ratio, image.width);
    near(result.height * ratio, image.height);
  }
});

test('fit stays inside the viewport and lands its size and position on display pixels', () => {
  for (const ratio of [1, 1.25, 1.5, 2]) {
    const view = viewport(ratio);
    const result = imagePreviewLayout(image, view, 'fit');
    assert.ok(result.width + 48 <= view.width);
    assert.ok(result.height + 48 <= view.height);
    near(result.width * ratio, Math.round(result.width * ratio));
    near(result.height * ratio, Math.round(result.height * ratio));
    near((result.left + view.left) * ratio, Math.round((result.left + view.left) * ratio));
    near((result.top + view.top) * ratio, Math.round((result.top + view.top) * ratio));
  }
});

test('small images are not enlarged by fit and remain centered at native resolution', () => {
  const small = { width: 80, height: 40 };
  const result = imagePreviewLayout(small, viewport(2), 'fit');
  assert.equal(result.scale, 1);
  assert.equal(result.width, 40);
  assert.equal(result.height, 20);
  assert.equal(result.canvasWidth, viewport(2).width);
});

test('explicit zoom grows the scrollable canvas without affecting subsequent fit calculations', () => {
  const view = viewport(1.25);
  const initial = imagePreviewLayout(image, view, 'fit');
  const zoomed = imagePreviewLayout(image, view, 2);
  assert.equal(zoomed.width, 2560);
  assert.equal(zoomed.canvasWidth, zoomed.width + 48);
  assert.deepEqual(imagePreviewLayout(image, view, 'fit'), initial);
});
