import test from 'node:test';
import assert from 'node:assert/strict';
import { installPicker } from '../scripts/pick.mjs';

function makeElement({
  tagName = 'DIV',
  id = '',
  className = '',
  classAttr = typeof className === 'string' ? className : '',
  textContent = '',
  outerHTML = `<${tagName.toLowerCase()}></${tagName.toLowerCase()}>`,
  parentElement = null,
} = {}) {
  const el = {
    tagName,
    id,
    className,
    textContent,
    outerHTML,
    parentElement,
    style: {},
    children: [],
    appendChild(child) {
      this.children.push(child);
      child.parentElement = this;
    },
    append(...children) {
      children.forEach((child) => this.appendChild(child));
    },
    contains(target) {
      return target === this || this.children.some((child) => child.contains?.(target));
    },
    remove() {
      this.removed = true;
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, width: 10, height: 10 };
    },
    getAttribute(name) {
      if (name === 'class') return classAttr;
      return null;
    },
  };
  return el;
}

function createPickerHarness(buildTarget) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const listeners = new Map();
  const body = makeElement({ tagName: 'BODY', outerHTML: '<body></body>' });
  const target = buildTarget(body);
  const document = {
    body,
    createElement(tag) {
      return makeElement({ tagName: tag.toUpperCase(), outerHTML: `<${tag}></${tag}>` });
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
    },
    elementFromPoint() {
      return target;
    },
  };

  globalThis.window = {};
  globalThis.document = document;
  installPicker();

  return {
    target,
    listeners,
    restore() {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    },
  };
}

function click(harness) {
  harness.listeners.get('click')({
    target: harness.target,
    clientX: 0,
    clientY: 0,
    metaKey: false,
    ctrlKey: false,
    preventDefault() {},
    stopPropagation() {},
  });
}

async function withTimeout(promise, ms) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('timed out waiting for picker promise')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('pick resolves inline SVG element info using getAttribute class fallback', async (t) => {
  const harness = createPickerHarness((body) => {
    const svg = makeElement({
      tagName: 'SVG',
      className: { baseVal: 'icon-root' },
      classAttr: 'icon-root',
      parentElement: body,
      outerHTML: '<svg class="icon-root"></svg>',
    });
    return makeElement({
      tagName: 'PATH',
      className: { baseVal: 'price-line active' },
      classAttr: 'price-line active',
      parentElement: svg,
      outerHTML: '<path class="price-line active"></path>',
    });
  });
  t.after(harness.restore);

  const promise = window.pick('Pick icon');
  click(harness);

  assert.deepEqual(await withTimeout(promise, 50), {
    tag: 'path',
    id: null,
    class: 'price-line active',
    text: null,
    html: '<path class="price-line active"></path>',
    parents: 'svg.icon-root',
  });
  assert.equal(harness.listeners.has('click'), false);
});

test('pick rejects extraction errors instead of leaving the click promise pending', async (t) => {
  const harness = createPickerHarness((body) => {
    const el = makeElement({ tagName: 'DIV', className: 'broken', parentElement: body });
    Object.defineProperty(el, 'outerHTML', {
      get() {
        throw new Error('outerHTML failed');
      },
    });
    return el;
  });
  t.after(harness.restore);

  const promise = window.pick('Pick broken element');
  assert.doesNotThrow(() => click(harness));

  await assert.rejects(withTimeout(promise, 50), /Picker failed to extract element info: outerHTML failed/);
  assert.equal(harness.listeners.has('click'), false);
});
