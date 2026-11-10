import test from 'node:test';
import assert from 'node:assert/strict';
import {setupAudioUpload, setupVoicePreview, VOICE_PREVIEW_TEXT} from '../packages/server/src/openspline_server/static/demo-audio.js';

class Control extends EventTarget {
  constructor(value = '') {super(); this.value = value; this.attributes = {}; this.files = [];}
  setAttribute(name, value) {this.attributes[name] = value;}
  removeAttribute(name) {delete this.attributes[name]; if (name === 'src') delete this.src;}
  change(value) {this.value = value; this.dispatchEvent(new Event('change'));}
}
class Player extends Control {
  pauses = 0;
  plays = 0;
  pause() {this.pauses++;}
  load() {}
  async play() {this.plays++;}
}
function urls() {
  let sequence = 0;
  return {
    active: new Map(), revoked: [],
    createObjectURL(blob) {const url = `blob:sample-${++sequence}`; this.active.set(url, blob); return url;},
    revokeObjectURL(url) {this.revoked.push(url); this.active.delete(url);},
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {resolve = ok; reject = fail;});
  return {promise, resolve, reject};
}
function voicePreview(synthesize = async () => new Blob(['wave'])) {
  const source = new Control('kokoro'), voice = new Control('bf_emma'), speed = new Control('1.25');
  const button = new Control(), audio = new Player(), message = {}, media = urls();
  const controller = setupVoicePreview(source, voice, speed, button, audio, message, synthesize, media);
  controller.setEnabled(true);
  return {source, voice, speed, button, audio, message, media, controller};
}

test('voice preview speaks a short sample at the selected speed without avatar inputs', async () => {
  let input;
  const ui = voicePreview(async value => {input = value; return new Blob(['wave']);});
  ui.button.dispatchEvent(new Event('click'));
  await ui.controller.wait();
  assert.deepEqual(input, {text: VOICE_PREVIEW_TEXT, voice: 'bf_emma', speed: 1.25});
  assert.equal(ui.audio.plays, 1);
  assert.equal(ui.audio.hidden, false);
  assert.equal(ui.button.disabled, false);
  assert.match(ui.message.textContent, /Voice preview/);
});

test('repeat previews reuse audio while different voices and speeds get distinct samples', async () => {
  const calls = [];
  const ui = voicePreview(async input => {calls.push(input); return new Blob(['wave']);});
  await ui.controller.preview();
  const firstURL = ui.audio.src;
  await ui.controller.preview();
  assert.equal(calls.length, 1);
  assert.ok(ui.media.revoked.includes(firstURL));
  ui.voice.change('af_heart');
  await ui.controller.preview();
  ui.speed.change('0.75');
  await ui.controller.preview();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].speed, .75);
  assert.equal(ui.media.active.size, 1);
});

test('changing voice during generation discards stale playback', async () => {
  const generation = deferred();
  const ui = voicePreview(() => generation.promise);
  const playing = ui.controller.preview();
  assert.equal(ui.button.disabled, true);
  ui.voice.change('af_heart');
  generation.resolve(new Blob(['old voice']));
  await playing;
  assert.equal(ui.audio.plays, 0);
  assert.equal(ui.audio.hidden, true);
  assert.equal(ui.media.active.size, 0);
  assert.equal(ui.button.disabled, false);
});

test('switching to uploads stops a preview and prevents further voice playback', async () => {
  const ui = voicePreview();
  await ui.controller.preview();
  const pauses = ui.audio.pauses;
  ui.source.change('file');
  assert.ok(ui.audio.pauses > pauses);
  assert.equal(ui.audio.hidden, true);
  assert.equal(ui.media.active.size, 0);
  assert.equal(ui.button.disabled, true);
  await ui.controller.preview();
  assert.equal(ui.audio.plays, 1);
});

test('starting avatar generation silences the preview and waits for its synthesis', async () => {
  const generation = deferred();
  const ui = voicePreview(() => generation.promise);
  const preview = ui.controller.preview();
  ui.controller.setEnabled(false);
  assert.equal(ui.controller.pending(), true);
  const completion = ui.controller.wait();
  generation.resolve(new Blob(['wave']));
  await Promise.all([preview, completion]);
  assert.equal(ui.audio.plays, 0);
  assert.equal(ui.button.disabled, true);
});

test('autoplay restrictions leave usable controls and a Play instruction', async () => {
  const ui = voicePreview();
  ui.audio.play = async () => {throw new Error('Autoplay blocked');};
  await ui.controller.preview();
  assert.equal(ui.audio.hidden, false);
  assert.match(ui.message.textContent, /Press Play/);
  assert.ok(ui.audio.src);
});

test('preview failures are visible and do not permanently disable the button', async () => {
  const ui = voicePreview(async () => {throw new Error('Kokoro is busy. Please try again.');});
  await ui.controller.preview();
  assert.match(ui.message.textContent, /Kokoro is busy/);
  assert.equal(ui.button.disabled, false);
  assert.equal(ui.media.active.size, 0);
});

test('leaving the page aborts pending previews and releases their media URLs', async () => {
  let aborted = false;
  const ui = voicePreview((input, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {aborted = true; reject(new DOMException('Cancelled', 'AbortError'));});
  }));
  const preview = ui.controller.preview();
  ui.controller.cleanup();
  await preview;
  assert.equal(aborted, true);
  assert.equal(ui.audio.hidden, true);
  assert.equal(ui.message.textContent, '');
});

function upload() {
  const source = new Control('kokoro'), input = new Control(), container = {}, audio = new Player(), media = urls();
  const controller = setupAudioUpload(source, input, container, audio, media);
  return {source, input, container, audio, media, controller};
}
test('upload mode is independently available and requires an audio file', () => {
  const ui = upload();
  assert.equal(ui.container.hidden, true);
  assert.equal(ui.input.required, false);
  assert.equal(ui.input.disabled, true);
  ui.source.change('file');
  assert.equal(ui.container.hidden, false);
  assert.equal(ui.input.required, true);
  assert.equal(ui.input.disabled, false);
});

test('uploaded audio can be previewed and survives switching audio sources', () => {
  const ui = upload();
  const file = new File(['speech'], 'my-voice.wav', {type: 'audio/wav'});
  ui.source.change('file');
  ui.input.files = [file]; ui.input.dispatchEvent(new Event('change'));
  const url = ui.audio.src;
  assert.equal(ui.audio.hidden, false);
  assert.equal(ui.media.active.get(url), file);
  ui.source.change('kokoro');
  assert.equal(ui.audio.hidden, true);
  ui.source.change('file');
  assert.equal(ui.input.files[0], file);
  assert.equal(ui.audio.src, url);
  assert.equal(ui.audio.hidden, false);
});

test('uploaded preview pauses during avatar playback and releases replaced recordings', () => {
  const ui = upload();
  ui.source.change('file');
  ui.input.files = [new File(['first'], 'first.wav')]; ui.input.dispatchEvent(new Event('change'));
  const first = ui.audio.src, pauses = ui.audio.pauses;
  ui.controller.setBusy(true);
  assert.equal(ui.input.disabled, true);
  assert.equal(ui.audio.hidden, true);
  assert.ok(ui.audio.pauses > pauses);
  ui.controller.setBusy(false);
  ui.input.files = [new File(['second'], 'second.wav')]; ui.input.dispatchEvent(new Event('change'));
  assert.ok(ui.media.revoked.includes(first));
  assert.equal(ui.media.active.size, 1);
  ui.controller.cleanup();
  assert.equal(ui.media.active.size, 0);
  ui.controller.refresh();
  assert.equal(ui.media.active.size, 1);
});
