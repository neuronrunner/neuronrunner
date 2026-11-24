const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
const filename = require('node:path').resolve(__dirname, '../src/lib/project-import.ts');
const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}});
const context = {exports:{},URL};
vm.runInNewContext(result.outputText,context);
const {parseGithubRepository,normalizeProjectPath} = context.exports;

test('GitHub import accepts URL, SSH and shorthand and derives a clean clone source',()=>{
  for(const value of ['acme/my.app','https://github.com/acme/my.app.git/','git@github.com:acme/my.app.git']){
    const repo=parseGithubRepository(value);assert.equal(repo.name,'my.app');assert.equal(repo.fullName,'acme/my.app');assert.equal(repo.url,'https://github.com/acme/my.app.git');
  }
});
test('repository input rejects other hosts, credential URLs and non-repository links',()=>{
  for(const input of ['https://github.com.evil/acme/repo','https://github.com@evil/acme/repo','https://secret@github.com/acme/repo','http://github.com/acme/repo','https://github.com/acme/repo/tree/main','acme/..','https://github.com/acme/repo?tab=readme','github.com/acme/repo']) assert.equal(parseGithubRepository(input),null,input);
});
test('destination permits named and nested folders but excludes root, metadata and escape paths',()=>{
  assert.equal(normalizeProjectPath(' /workspace/My Application/ '),'/workspace/My Application');
  assert.equal(normalizeProjectPath('/workspace/team/repo'),'/workspace/team/repo');
  for(const input of ['/workspace','/workspace/','/tmp/repo','/workspace/../repo','/workspace/.git/hooks','/workspace/repo/./child','/workspace/repo\\child','/workspace/repo\0'])assert.equal(normalizeProjectPath(input),null,input);
});
