import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';

const guard = readFileSync(new URL('../guard.js', import.meta.url), 'utf8');
const origin = 'https://nuc.alphacoding.cn';

function createPage(t, { enabled = true, path = '/exam/examsingleMode/paper-1/0/0' } = {}) {
  const dom = new JSDOM('<input id="answer"><textarea id="code"></textarea><button>下一题</button>', {
    url: origin + path,
    runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  if (enabled) dom.window.eval(guard);
  return dom.window;
}

function installExamCounter(window) {
  // Reproduce the observed window.blur -> leavePage -> server count flow.
  const state = { count: 4, reports: [] };
  window.addEventListener('blur', () => {
    state.reports.push({ examineePaperId: 'paper-1' });
    state.count += 1;
  });
  return state;
}

test('without the extension, leaving the window reports and increases the count', (t) => {
  const window = createPage(t, { enabled: false });
  const state = installExamCounter(window);
  window.dispatchEvent(new window.FocusEvent('blur'));
  assert.equal(state.count, 5);
  assert.deepEqual(state.reports, [{ examineePaperId: 'paper-1' }]);
});

test('repeated window switches produce no reports and preserve the existing count', (t) => {
  const window = createPage(t);
  const state = installExamCounter(window);
  for (let i = 0; i < 3; i += 1) {
    window.dispatchEvent(new window.FocusEvent('blur'));
    window.dispatchEvent(new window.FocusEvent('focus'));
  }
  assert.equal(state.count, 4);
  assert.deepEqual(state.reports, []);
});

test('window handlers are blocked even when registered in capture or onblur', (t) => {
  const window = createPage(t);
  let reports = 0;
  window.addEventListener('blur', () => { reports += 1; }, true);
  window.onblur = () => { reports += 1; };
  window.dispatchEvent(new window.FocusEvent('blur'));
  assert.equal(reports, 0);
});

test('changing fields still saves fill answers and code on element blur', (t) => {
  const window = createPage(t);
  const state = installExamCounter(window);
  const input = window.document.querySelector('input');
  const editor = window.document.querySelector('textarea');
  const saved = [];
  const captured = [];
  window.addEventListener('blur', (event) => captured.push(event.target.id), true);
  input.onblur = () => saved.push(input.value);
  editor.addEventListener('blur', () => saved.push(editor.value));

  input.focus();
  input.value = '42';
  editor.focus();
  editor.value = 'print(42)';
  window.document.querySelector('button').focus();

  assert.deepEqual(saved, ['42', 'print(42)']);
  assert.deepEqual(captured, ['answer', 'code']);
  assert.deepEqual(state.reports, []);
});

test('SPA entry and question changes stay protected; leaving the exam restores window blur', (t) => {
  const window = createPage(t, { path: '/exam/login/before/exam-1' });
  const state = installExamCounter(window);
  window.dispatchEvent(new window.FocusEvent('blur'));
  assert.equal(state.count, 5);

  for (const path of ['/exam/examSingleMode/paper-1/0/0', '/exam/examsingleMode/paper-1/0/1', '/exam/examMode/paper-1']) {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new window.FocusEvent('blur'));
    assert.equal(state.count, 5);
  }

  window.history.pushState({}, '', '/exam/home');
  window.dispatchEvent(new window.FocusEvent('blur'));
  assert.equal(state.count, 6);
});

test('management, course, and unrelated routes keep their normal blur behavior', (t) => {
  const window = createPage(t);
  const state = installExamCounter(window);
  const paths = ['/exam/examRoomFree/exam-1', '/courses/1', '/exam/examModeSettings/1', '/exam/examSingleMode/'];
  for (const path of paths) {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new window.FocusEvent('blur'));
  }
  assert.equal(state.count, 4 + paths.length);
});

test('focus, navigation prompts, input, and button actions still reach page handlers', (t) => {
  const window = createPage(t);
  const handled = [];
  for (const type of ['focus', 'beforeunload', 'pagehide', 'visibilitychange']) {
    window.addEventListener(type, () => handled.push(type));
    window.dispatchEvent(new window.Event(type));
  }
  const input = window.document.querySelector('input');
  input.addEventListener('input', () => handled.push('input'));
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  const button = window.document.querySelector('button');
  button.onclick = () => handled.push('next-question');
  button.click();
  assert.deepEqual(handled, ['focus', 'beforeunload', 'pagehide', 'visibilitychange', 'input', 'next-question']);
});
