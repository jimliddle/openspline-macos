import test from 'node:test';
import assert from 'node:assert/strict';
import {portraitCrop, movePortraitCrop, zoomPortraitCrop, setupPortraitCrop} from '../packages/server/src/openspline_server/static/demo-portrait.js';

test('square selections stay inside tall, wide and square source images at every zoom and edge', () => {
  for (const [width, height] of [[1200, 800], [800, 1200], [512, 512]]) {
    for (const zoom of [1, 1.5, 4]) for (const x of [-1, 0, .5, 1, 2]) for (const y of [-1, 0, .5, 1, 2]) {
      const crop = portraitCrop(width, height, {zoom, x, y});
      assert.equal(crop.size, Math.min(width, height) / zoom);
      assert.ok(crop.x >= 0 && crop.y >= 0);
      assert.ok(crop.x + crop.size <= width && crop.y + crop.size <= height);
    }
  }
  assert.deepEqual(portraitCrop(1200, 800), {x: 200, y: 0, size: 800});
});

test('zoom preserves the selected face center and panning stops at image edges', () => {
  const state = {zoom: 2, x: .3, y: .6};
  const before = portraitCrop(1200, 800, state);
  const zoomed = zoomPortraitCrop(1200, 800, state, 3);
  const after = portraitCrop(1200, 800, zoomed);
  assert.ok(Math.abs(before.x + before.size / 2 - after.x - after.size / 2) < 1e-9);
  assert.ok(Math.abs(before.y + before.size / 2 - after.y - after.size / 2) < 1e-9);
  assert.deepEqual(movePortraitCrop(1200, 800, state, 1e6, -1e6), {zoom: 2, x: 1, y: 0});
  assert.deepEqual(movePortraitCrop(512, 512, {zoom: 1, x: .5, y: .5}, 50, -50), {zoom: 1, x: .5, y: .5});
});

class Control extends EventTarget {
  attributes = {};
  files = [];
  setAttribute(name, value) {this.attributes[name] = value;}
  focus() {this.focused = true;}
  click() {this.dispatchEvent(new Event('click'));}
  input(value) {this.value = value; this.dispatchEvent(new Event('input'));}
  event(type, properties = {}) {const event = Object.assign(new Event(type, {cancelable: true}), properties); this.dispatchEvent(event); return event;}
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {resolve = ok; reject = fail;});
  return {promise, resolve, reject};
}

function editor({decode = async () => ({naturalWidth: 1200, naturalHeight: 800})} = {}) {
  const input = new Control();
  const ui = Object.fromEntries(['preview', 'empty', 'canvas', 'grid', 'controls', 'actions', 'edit', 'original', 'editor', 'zoom', 'zoomValue', 'horizontal', 'vertical', 'apply', 'cancel', 'reset', 'message'].map(name => [name, new Control()]));
  const drawing = {fillRect() {}, drawImage(...args) {this.selection = args;}};
  ui.canvas.getContext = () => drawing;
  ui.canvas.getBoundingClientRect = () => ({width: 400, height: 400});
  ui.canvas.setPointerCapture = id => {ui.canvas.captured = id;};
  ui.canvas.toBlob = (callback, type) => {callback(new Blob(['encoded crop'], {type}));};
  const urls = {
    active: new Map(), revoked: [], next: 0,
    createObjectURL(blob) {const url = `blob:portrait-${++this.next}`; this.active.set(url, blob); return url;},
    revokeObjectURL(url) {this.revoked.push(url); this.active.delete(url);},
  };
  const controller = setupPortraitCrop(input, ui, {decode, urls});
  return {input, ui, drawing, urls, controller,
    async select(file = new File(['image'], 'headshot.jpg', {type: 'image/jpeg'})) {
      input.files = file ? [file] : [];
      input.dispatchEvent(new Event('change'));
      await controller.wait();
      return file;
    },
  };
}

test('original uploads are preserved until a crop is chosen', async () => {
  const e = editor();
  const original = await e.select();
  assert.equal(await e.controller.file(), original);
  assert.equal(e.ui.preview.hidden, false);
  assert.equal(e.ui.canvas.hidden, true);
  assert.equal(e.ui.original.hidden, true);
  assert.equal(e.urls.active.size, 1);
});

test('the selected source region is drawn to 512 square and the exported PNG becomes the submitted file', async () => {
  const e = editor();
  await e.select();
  e.ui.edit.click();
  e.ui.zoom.input(2);
  e.ui.horizontal.input(25);
  e.ui.vertical.input(75);
  assert.deepEqual(e.drawing.selection.slice(1), [200, 300, 400, 400, 0, 0, 512, 512]);
  e.ui.apply.click();
  await e.controller.wait();
  const file = await e.controller.file();
  assert.equal(file.name, 'headshot-crop.png');
  assert.equal(file.type, 'image/png');
  assert.equal(e.urls.active.get(e.ui.preview.src), file);
  assert.equal(e.ui.canvas.hidden, true);
  assert.equal(e.ui.editor.hidden, true);
  assert.equal(e.ui.original.hidden, false);
  assert.equal(e.ui.edit.textContent, 'Adjust crop');
});

test('Speak commits a visible draft even while generation controls are locked', async () => {
  const e = editor();
  await e.select();
  e.ui.edit.click();
  e.ui.zoom.input(2);
  e.controller.setBusy(true);
  const file = await e.controller.file();
  assert.equal(file.name, 'headshot-crop.png');
  assert.equal(e.input.disabled, true);
  e.controller.setBusy(false);
  assert.equal(e.input.disabled, false);
});

test('adjusting a crop starts from the original source and Cancel preserves the applied crop', async () => {
  const e = editor();
  const source = await e.select();
  e.ui.edit.click();
  e.ui.zoom.input(2);
  const cropped = await e.controller.file();
  const selection = e.drawing.selection;
  e.ui.edit.click();
  assert.deepEqual(e.drawing.selection, selection);
  assert.equal(e.ui.zoom.value, 2);
  e.ui.zoom.input(3);
  e.ui.cancel.click();
  assert.equal(await e.controller.file(), cropped);
  e.ui.original.click();
  assert.equal(await e.controller.file(), source);
  assert.equal(e.urls.active.size, 1);
});

test('dragging and keyboard movement reposition the crop with edge clamping; Reset restores the initial frame', async () => {
  const e = editor();
  await e.select();
  e.ui.edit.click();
  e.ui.zoom.input(2);
  const startingX = e.drawing.selection[1];
  e.ui.canvas.event('pointerdown', {pointerId: 7, button: 0, clientX: 200, clientY: 200});
  e.ui.canvas.event('pointermove', {pointerId: 7, clientX: 300, clientY: 200});
  assert.equal(e.drawing.selection[1], startingX - 100);
  e.ui.canvas.event('pointermove', {pointerId: 7, clientX: 10000, clientY: 10000});
  assert.deepEqual(e.drawing.selection.slice(1, 3), [0, 0]);
  e.ui.canvas.event('pointerup', {pointerId: 7});
  assert.equal(e.ui.canvas.event('keydown', {key: 'ArrowLeft', shiftKey: true}).defaultPrevented, true);
  assert.equal(e.drawing.selection[1], 40);
  e.ui.reset.click();
  assert.deepEqual(e.drawing.selection.slice(1), [200, 0, 800, 800, 0, 0, 512, 512]);
  assert.equal(e.ui.zoom.value, 1);
});

test('portrait editing stays locked during avatar playback and is restored after ending the session', async () => {
  const e = editor();
  await e.select();
  e.controller.setBusy(true);
  e.controller.setPlaying(true);
  e.controller.setBusy(false);
  assert.equal(e.input.disabled, true);
  assert.equal(e.ui.edit.disabled, true);
  assert.equal(e.ui.preview.hidden, true);
  e.ui.edit.click();
  assert.equal(e.ui.canvas.hidden, true);
  e.controller.setPlaying(false);
  assert.equal(e.input.disabled, false);
  assert.equal(e.ui.preview.hidden, false);
  e.ui.edit.click();
  assert.equal(e.ui.canvas.hidden, false);
});

test('a new upload resets cropping and releases old preview URLs', async () => {
  const e = editor();
  await e.select();
  e.ui.edit.click();
  await e.controller.file();
  const oldURLs = [...e.urls.active.keys()];
  const next = await e.select(new File(['other image'], 'next.png', {type: 'image/png'}));
  assert.equal(await e.controller.file(), next);
  assert.ok(oldURLs.every(url => e.urls.revoked.includes(url)));
  assert.equal(e.urls.active.size, 1);
  assert.equal(e.ui.edit.textContent, 'Crop portrait');
});

test('a stale image load cannot replace a newer portrait or leak a preview URL', async () => {
  const first = deferred();
  let count = 0;
  const e = editor({decode: async () => ++count === 1 ? first.promise : {naturalWidth: 800, naturalHeight: 1200}});
  e.input.files = [new File(['first'], 'first.jpg')];
  e.input.dispatchEvent(new Event('change'));
  const next = await e.select(new File(['second'], 'second.jpg'));
  first.resolve({naturalWidth: 1200, naturalHeight: 800});
  await first.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await e.controller.file(), next);
  assert.equal(e.urls.active.size, 1);
  e.ui.edit.click();
  assert.deepEqual(e.drawing.selection.slice(1, 4), [0, 200, 800]);
});

test('invalid images fail before synthesis and allow a replacement portrait', async () => {
  let bad = true;
  const e = editor({decode: async () => {if (bad) throw new Error('decode failed'); return {naturalWidth: 800, naturalHeight: 800};}});
  await e.select();
  await assert.rejects(e.controller.file(), /Could not open/);
  assert.match(e.ui.message.textContent, /Could not open/);
  assert.equal(e.input.disabled, false);
  assert.equal(e.urls.active.size, 0);
  bad = false;
  const good = await e.select();
  assert.equal(await e.controller.file(), good);
});

test('the existing file-size and pixel-count limits apply before cropping', async () => {
  const e = editor();
  await e.select({name: 'huge.jpg', size: 10 * 1024 * 1024 + 1});
  await assert.rejects(e.controller.file(), /10 MB/);
  const hugePixels = editor({decode: async () => ({naturalWidth: 5000, naturalHeight: 4000})});
  await hugePixels.select();
  await assert.rejects(hugePixels.controller.file(), /16 megapixels/);
  assert.equal(hugePixels.urls.active.size, 0);
});

test('failed PNG encoding leaves the draft editable and can be retried', async () => {
  const e = editor();
  await e.select();
  e.ui.edit.click();
  e.ui.canvas.toBlob = callback => callback(null);
  await assert.rejects(e.controller.file(), /Could not save/);
  assert.equal(e.ui.editor.disabled, false);
  assert.equal(e.ui.canvas.hidden, false);
  e.ui.cancel.click();
  e.ui.edit.click();
  e.ui.canvas.toBlob = (callback, type) => callback(new Blob(['crop'], {type}));
  assert.equal((await e.controller.file()).type, 'image/png');
});

test('leaving during crop encoding releases image URLs and prevents a late result from being uploaded', async () => {
  const e = editor();
  await e.select();
  e.ui.edit.click();
  let finish;
  e.ui.canvas.toBlob = callback => {finish = callback;};
  const saving = e.controller.file();
  await Promise.resolve();
  e.controller.cleanup();
  finish(new Blob(['late crop'], {type: 'image/png'}));
  await assert.rejects(saving, /portrait changed/);
  assert.equal(e.urls.active.size, 0);
  e.controller.refresh();
  await e.controller.wait();
  assert.equal((await e.controller.file()).name, 'headshot.jpg');
});
