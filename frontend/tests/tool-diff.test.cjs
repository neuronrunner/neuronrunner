const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadTs(relPath) {
  const filename = path.resolve(__dirname, '..', relPath);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText,
    filename,
  );
  return loaded.exports;
}

const { extractToolDiff } = loadTs('src/components/chat/tool-diff.ts');

test('extractToolDiff builds unified diff from file_patch find/replace arguments', () => {
  const diff = extractToolDiff({
    id: 'tc_1',
    name: 'file_patch',
    status: 'done',
    arguments: JSON.stringify({
      path: 'src/app.ts',
      find: 'const a = 1;\nconst b = 2;',
      replace: 'const a = 1;\nconst b = 3;\nconst c = 4;',
    }),
    result: '{"path":"src/app.ts","replacements":1}',
  });

  assert.ok(diff);
  assert.equal(diff.additions, 2);
  assert.equal(diff.deletions, 1);
  assert.ok(diff.rawDiff.includes('--- a/src/app.ts'));
  assert.ok(diff.rawDiff.includes('+++ b/src/app.ts'));
  assert.ok(diff.rawDiff.includes('-const b = 2;'));
  assert.ok(diff.rawDiff.includes('+const b = 3;'));
  assert.ok(diff.rawDiff.includes('+const c = 4;'));
});

test('extractToolDiff builds unified diff from Edit old_string/new_string arguments', () => {
  const diff = extractToolDiff({
    id: 'tc_2',
    name: 'Edit',
    status: 'done',
    arguments: {
      file_path: 'frontend/page.tsx',
      old_string: 'return <div>Old</div>;',
      new_string: 'return <div>New</div>;',
    },
    result: 'The file has been updated.',
  });

  assert.ok(diff);
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
  assert.ok(diff.rawDiff.includes('-return <div>Old</div>;'));
  assert.ok(diff.rawDiff.includes('+return <div>New</div>;'));
});

test('extractToolDiff builds addition diff from file_write content arguments', () => {
  const diff = extractToolDiff({
    id: 'tc_3',
    name: 'file_write',
    status: 'done',
    arguments: {
      path: 'hello.py',
      content: 'def hi():\n    return "hello"',
    },
  });

  assert.ok(diff);
  assert.equal(diff.additions, 2);
  assert.equal(diff.deletions, 0);
  assert.ok(diff.rawDiff.includes('+++ b/hello.py'));
  assert.ok(diff.rawDiff.includes('+def hi():'));
});

test('extractToolDiff preserves existing unified diff in tool output', () => {
  const unified = '--- a/foo.py\n+++ b/foo.py\n@@ -1,2 +1,2 @@\n-old\n+new\n same';
  const diff = extractToolDiff({
    id: 'tc_4',
    name: 'edit_file',
    status: 'done',
    arguments: {},
    output: unified,
  });

  assert.ok(diff);
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
  assert.equal(diff.rawDiff, unified);
});
