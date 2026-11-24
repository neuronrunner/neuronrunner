const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../src/components/chat/view-image.ts');
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded.require = id => id === '@/i18n' ? { __esModule: true, default: { t: k => k } } : Module.prototype.require.call(loaded, id);
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, filename);
const { viewedImages } = loaded.exports;
const image = (source, url) => ({ status: 'ok', source, image_url: url });

test('a single saved image keeps its preview', () => {
  assert.deepEqual(viewedImages(JSON.stringify(image('photo.png', 'data:image/png;base64,AA=='))), [{ source: 'photo.png', url: 'data:image/png;base64,AA==' }]);
});

test('a partial batch previews successful sources in order', () => {
  const result = { status: 'partial', images: [image('first.png', 'data:image/png;base64,AA=='), { source: 'missing.png', error: 'not found' }, image('second.jpg', 'https://example.com/photo.jpg')] };
  assert.deepEqual(viewedImages(JSON.stringify(result)), [{ source: 'first.png', url: 'data:image/png;base64,AA==' }, { source: 'second.jpg', url: 'https://example.com/photo.jpg' }]);
});

test('pending, failed, and malformed tool results do not create previews', () => {
  for (const result of [undefined, '', '{', null, [], { error: 'failed' }, { images: [null, {}, { status: 'ok', image_url: 'file:///etc/passwd' }, { status: 'ok', image_url: 'javascript:alert(1)' }] }]) {
    assert.deepEqual(viewedImages(result), []);
  }
});
