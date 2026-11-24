const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../src/lib/file-upload.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, context);
const { selectedUploadFiles, uploadDestination, droppedUploadFiles } = context.exports;

test('folder selection preserves the root folder and nested paths at the selected destination', () => {
  const selected = selectedUploadFiles([{ name: 'index.py', webkitRelativePath: 'app/src/index.py' }, { name: 'README.md', webkitRelativePath: '' }]);
  assert.equal(uploadDestination('/workspace/project/', selected.files[0].relativePath), '/workspace/project/app/src/index.py');
  assert.equal(uploadDestination('/workspace/project', selected.files[1].relativePath), '/workspace/project/README.md');
});

test('upload destinations reject traversal and malformed folder paths', () => {
  for (const input of ['../secret', '/etc/passwd', 'app//file', 'app/./file', 'app/../file', 'app\\file', 'app/\0file']) {
    assert.throws(() => uploadDestination('/workspace/project', input), /Invalid upload path/);
  }
});

const fileEntry = name => ({ name, isFile: true, file: resolve => resolve({ name }) });
const directoryEntry = (name, batches) => ({ name, isDirectory: true, createReader() {
  let index = 0;
  return { readEntries: resolve => resolve(batches[index++] || []) };
} });

test('dropping a folder reads every directory batch, keeps nested paths and empty folders', async () => {
  const root = directoryEntry('app', [[fileEntry('first.py')], [directoryEntry('src', [[fileEntry('last.py')]]), directoryEntry('empty', [])]]);
  const result = await droppedUploadFiles({ items: [{ kind: 'file', webkitGetAsEntry: () => root, getAsFile: () => null }], files: [] });
  assert.equal(JSON.stringify(result.directories), JSON.stringify(['app', 'app/src', 'app/empty']));
  assert.equal(JSON.stringify(result.files.map(file => file.relativePath)), JSON.stringify(['app/first.py', 'app/src/last.py']));
});

test('dropping plain files works with and without directory entry support', async () => {
  const file = { name: 'hello.py' };
  for (const items of [[], [{ kind: 'file', getAsFile: () => file }]]) {
    const result = await droppedUploadFiles({ items, files: [file] });
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].file, file);
    assert.equal(result.files[0].relativePath, 'hello.py');
  }
});

test('an unreadable dropped directory rejects instead of returning a partial successful selection', async () => {
  const entry = { name: 'unreadable', isDirectory: true, createReader: () => ({ readEntries: (resolve, reject) => reject(new Error('Access denied')) }) };
  await assert.rejects(droppedUploadFiles({ items: [{ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null }], files: [] }), /Access denied/);
});
