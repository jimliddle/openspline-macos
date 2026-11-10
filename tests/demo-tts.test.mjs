import test from 'node:test';
import assert from 'node:assert/strict';
import {setupLocalSpeech, speechInput} from '../packages/server/src/openspline_server/static/demo-tts.js';

globalThis.Option = class {constructor(name, value) {this.textContent = name; this.value = value;}};
class Field extends EventTarget {
  constructor(value = '') {super(); this.value = value;}
  replaceChildren(...options) {this.options = options; this.value = options[0]?.value ?? '';}
  setAttribute(name, value) {this[name] = value;}
  removeAttribute(name) {delete this[name];}
}
const status = {
  ready: true, max_characters: 2000, default_voice: 'af_heart', message: 'Generated on this Mac.',
  voices: [{id: 'af_heart', name: 'Heart'}, {id: 'bf_emma', name: 'Emma'}],
};
async function setup(request = async () => status, fetcher, withPreview = false) {
  const source = new Field('kokoro');
  const fields = {
    fieldset: {}, text: new Field('Hello!'), voice: new Field('af_heart'), speed: new Field('1'),
    hint: {}, count: {}, start: {},
  };
  if (withPreview) Object.assign(fields, {
    previewButton: new Field(), previewMessage: {},
    previewAudio: Object.assign(new Field(), {pause() {}, load() {}, async play() {}}),
  });
  const controller = setupLocalSpeech(request, source, fields, fetcher);
  await controller.ready;
  return {source, fields, controller, select(value) {source.value = value; source.dispatchEvent(new Event('change'));}};
}

test('typed speech validates text and speed before sending a request', () => {
  assert.deepEqual(speechInput(' Hello! ', 'bf_emma', '1.25'), {text: 'Hello!', voice: 'bf_emma', speed: 1.25});
  for (const text of ['', '  ', 'x'.repeat(2001)]) assert.throws(() => speechInput(text, 'af_heart', 1));
  for (const speed of ['fast', NaN, Infinity, 0.49, 2.01]) assert.throws(() => speechInput('Hello', 'af_heart', speed));
});

test('text controls and primary action follow the selected audio source', async () => {
  const ui = await setup();
  assert.equal(ui.fields.fieldset.hidden, false);
  assert.equal(ui.fields.text.required, true);
  assert.equal(ui.fields.start.textContent, 'Speak');
  assert.equal(ui.fields.start.disabled, false);
  assert.equal(ui.fields.voice.options.length, 2);
  ui.controller.setBusy(true);
  assert.equal(ui.fields.start.disabled, true);
  assert.equal(ui.fields.fieldset.disabled, true);
  ui.controller.setBusy(false);
  ui.select('file');
  assert.equal(ui.fields.fieldset.hidden, true);
  assert.equal(ui.fields.fieldset.disabled, true);
  assert.equal(ui.fields.text.required, false);
  assert.equal(ui.fields.start.textContent, 'Start demo');
  assert.equal(ui.fields.start.disabled, false);
});

test('missing Kokoro disables Speak while still allowing uploaded audio', async () => {
  const ui = await setup(async () => ({...status, ready: false, message: 'Run setup-kokoro.sh'}));
  assert.equal(ui.fields.start.disabled, true);
  await assert.rejects(ui.controller.generate(() => {}), /setup-kokoro/);
  ui.select('file');
  assert.equal(ui.fields.start.disabled, false);
});

test('generation sends the chosen voice and speed and returns an uploadable WAV File', async () => {
  let sent;
  const ui = await setup(undefined, async (url, init) => {
    sent = {url, ...init};
    return new Response(new Blob(['wave'], {type: 'audio/wav'}));
  });
  ui.fields.voice.value = 'bf_emma';
  ui.fields.speed.value = '0.75';
  const progress = [];
  const signal = new AbortController().signal;
  const file = await ui.controller.generate(message => progress.push(message), signal);
  assert.equal(sent.url, '/v1/tts');
  assert.equal(sent.method, 'POST');
  assert.equal(sent.signal, signal);
  assert.deepEqual(JSON.parse(sent.body), {text: 'Hello!', voice: 'bf_emma', speed: .75});
  assert.equal(file.name, 'kokoro-speech.wav');
  assert.equal(file.type, 'audio/wav');
  assert.equal(await file.text(), 'wave');
  assert.match(progress[0], /locally/);
});

test('server synthesis errors remain visible to the user', async () => {
  const ui = await setup(undefined, async () => new Response(JSON.stringify({error: {message: 'Please wait'}}), {status: 429}));
  await assert.rejects(ui.controller.generate(() => {}), /Please wait/);
});

test('an old server prompts a restart without preventing audio file mode', async () => {
  const ui = await setup(async () => {throw new Error('404');});
  assert.equal(ui.fields.start.disabled, true);
  assert.match(ui.fields.hint.textContent, /Restart OpenSpline/);
  ui.select('file');
  assert.equal(ui.fields.start.disabled, false);
});

test('voice preview works with an empty speech textbox and does not generate avatar text', async () => {
  let heard;
  const played = new Promise(resolve => {heard = resolve;});
  const requests = [];
  const ui = await setup(undefined, async (url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(new Blob(['preview'], {type: 'audio/wav'}));
  }, true);
  ui.fields.text.value = '';
  ui.fields.previewAudio.play = async () => {heard();};
  ui.fields.previewButton.dispatchEvent(new Event('click'));
  await played;
  assert.equal(requests.length, 1);
  assert.match(requests[0].text, /sample of my voice/);
  assert.equal(requests[0].voice, 'af_heart');
  await assert.rejects(ui.controller.generate(() => {}), /Enter some text/);
  ui.controller.cleanup();
});

test('speaking waits for a pending preview so Kokoro requests never overlap', async () => {
  let release;
  const previewResponse = new Promise(resolve => {release = resolve;});
  const requests = [];
  const ui = await setup(undefined, async (url, init) => {
    requests.push(JSON.parse(init.body));
    return requests.length === 1 ? previewResponse : new Response(new Blob(['speech'], {type: 'audio/wav'}));
  }, true);
  let played = 0;
  ui.fields.previewAudio.play = async () => {played++;};
  ui.fields.previewButton.dispatchEvent(new Event('click'));
  ui.controller.setBusy(true);
  const progress = [];
  const speech = ui.controller.generate(message => progress.push(message));
  await Promise.resolve();
  assert.equal(requests.length, 1);
  release(new Response(new Blob(['preview'], {type: 'audio/wav'})));
  const file = await speech;
  assert.equal(await file.text(), 'speech');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].text, 'Hello!');
  assert.equal(played, 0);
  assert.match(progress[0], /Finishing the voice preview/);
  ui.controller.cleanup();
});
