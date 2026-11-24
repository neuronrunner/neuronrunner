const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const storage = new Map();
let reducedMotion = false;
global.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
global.window = { matchMedia: () => ({ matches: reducedMotion }) };
const filename = path.resolve(__dirname, '../src/lib/prompt-transition.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled.outputText, filename);
const { savePromptTransition, takePromptTransition, animatePromptPosition, prepareNewChatTransition, prepareConversationTransition } = loaded.exports;
const pending = () => ({ conversationId: 'new-chat', position: { top: 400, left: 100, width: 700 }, endsAt: performance.now() + 650 });
beforeEach(() => { storage.clear(); reducedMotion = false; delete global.document; });

test('a new chat continues the pending motion once, so completion cannot replay it', () => {
  const transition = pending();
  savePromptTransition(transition);
  assert.deepEqual(takePromptTransition('new-chat'), transition);
  assert.equal(takePromptTransition('new-chat'), null);
});

test('delayed route loading does not restart a completed input animation', () => {
  savePromptTransition({ ...pending(), endsAt: performance.now() - 1 });
  assert.equal(takePromptTransition('new-chat'), null);
  assert.equal(storage.size, 0);
});

test('opening another conversation does not inherit the first sends input position', () => {
  savePromptTransition(pending());
  assert.equal(takePromptTransition('other-chat'), null);
  assert.equal(takePromptTransition('new-chat'), null);
});

test('malformed or detached input geometry is discarded without breaking navigation', () => {
  storage.set('home_prompt_transition', '{invalid');
  assert.equal(takePromptTransition('new-chat'), null);
  savePromptTransition({ ...pending(), position: { top: 0, left: 0, width: 0 } });
  assert.equal(takePromptTransition('new-chat'), null);
});

test('reduced motion and completed transitions never animate the input', () => {
  const element = { animate: () => assert.fail('Unexpected input animation') };
  reducedMotion = true;
  assert.equal(animatePromptPosition(element, pending().position, 650), null);
  reducedMotion = false;
  assert.equal(animatePromptPosition(element, pending().position, 0), null);
});

test('a route handoff keeps the original easing progress rather than starting another entrance', () => {
  const animation = { currentTime: null };
  const element = {
    getBoundingClientRect: () => ({ top: 750, left: 80, width: 800 }),
    animate: (frames, timing) => { assert.equal(timing.duration, 650); return animation; },
  };
  assert.equal(animatePromptPosition(element, pending().position, 650, 300), animation);
  assert.equal(animation.currentTime, 300);
});

test('a route arriving after the motion completes does not replay the original geometry', () => {
  const element = { animate: () => assert.fail('Unexpected completed transition replay') };
  assert.equal(animatePromptPosition(element, pending().position, 650, 650), null);
  assert.equal(animatePromptPosition(element, pending().position, 650, 900), null);
});

test('busy route rendering cannot shift the animation clock away from the browser timeline', () => {
  global.document = { timeline: { currentTime: 1000 } };
  const animation = { currentTime: null, startTime: null };
  const element = { getBoundingClientRect: () => ({ top: 750, left: 80, width: 800 }), animate: () => animation };
  animatePromptPosition(element, pending().position, 650, 300);
  assert.equal(animation.currentTime, 300);
  assert.equal(animation.startTime, 700);
});

test('New Chat uses the actual composer geometry and allows time for navigation', () => {
  const position = { top: 750, left: 80, width: 800 };
  global.document = { timeline: { currentTime: 1000 }, querySelector: () => ({ getBoundingClientRect: () => position }) };
  prepareNewChatTransition();
  document.timeline.currentTime = 4000;
  const transition = takePromptTransition('new-chat');
  assert.deepEqual(transition.position, position);
  assert.equal(transition.endsAt, document.timeline.currentTime + 650);
  assert.equal(takePromptTransition('new-chat'), null);
});

test('opening a saved conversation moves from the home composer and starts after route loading', () => {
  const position = { top: 400, left: 120, width: 700 };
  global.document = {
    timeline: { currentTime: 1000 },
    querySelector: selector => {
      assert.equal(selector, '[data-chat-composer="home"]');
      return { getBoundingClientRect: () => position };
    },
  };
  prepareConversationTransition('saved-chat');
  document.timeline.currentTime = 4000;
  const transition = takePromptTransition('saved-chat');
  assert.deepEqual(transition.position, position);
  assert.equal(transition.endsAt, 4650);
  assert.equal(transition.startsOnMount, false);
  assert.equal(takePromptTransition('saved-chat'), null);
});

test('creating a conversation resumes the first send timeline without restarting it', () => {
  global.document = { timeline: { currentTime: 1000 } };
  savePromptTransition({ conversationId: 'created-chat', position: pending().position, endsAt: 1650 });
  document.timeline.currentTime = 1300;
  const transition = takePromptTransition('created-chat');
  assert.equal(transition.endsAt, 1650);
  const animation = { currentTime: null, startTime: null };
  const element = { getBoundingClientRect: () => ({ top: 750, left: 80, width: 800 }), animate: () => animation };
  animatePromptPosition(element, transition.position, 650, document.timeline.currentTime - (transition.endsAt - 650));
  assert.equal(animation.currentTime, 300);
  assert.equal(animation.startTime, 1000);
});
