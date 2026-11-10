import {setupVoicePreview} from './demo-audio.js';

export function speechInput(text, voice, speed, limit = 2000) {
  text = text.trim();
  if (!text) throw new Error('Enter some text for the avatar to say.');
  if ([...text].length > limit) throw new Error(`Text must be ${limit.toLocaleString()} characters or fewer.`);
  speed = Number(speed);
  if (!Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new Error('Speech speed must be between 0.5 and 2.0.');
  if (!voice) throw new Error('Choose a Kokoro voice.');
  return {text, voice, speed};
}

export function setupLocalSpeech(request, source, fields, fetcher = globalThis.fetch) {
  const {fieldset, text, voice, speed, hint, count, start} = fields;
  let available = false, busy = false, limit = 2000;
  async function synthesize(input, signal) {
    const response = await fetcher('/v1/tts', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(input), signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message ?? `Speech generation failed (${response.status}).`);
    }
    return response.blob();
  }
  const preview = fields.previewButton && setupVoicePreview(
    source, voice, speed, fields.previewButton, fields.previewAudio, fields.previewMessage, synthesize,
  );
  function render() {
    const local = source.value === 'kokoro';
    fieldset.hidden = !local;
    fieldset.disabled = !local || busy;
    text.required = local;
    start.textContent = local ? 'Speak' : 'Start demo';
    start.disabled = busy || (local && !available);
    preview?.setEnabled(local && available && !busy);
    count.textContent = `${[...text.value].length.toLocaleString()} / ${limit.toLocaleString()}`;
  }
  source.addEventListener('change', render);
  text.addEventListener('input', render);
  render();
  const ready = (async () => {
    try {
      const status = await request('/v1/tts', {cache: 'no-store'});
      available = status.ready;
      limit = status.max_characters;
      text.maxLength = limit;
      voice.replaceChildren(...status.voices.map(item => new Option(item.name, item.id)));
      voice.value = status.default_voice;
      hint.textContent = status.message;
    } catch {
      hint.textContent = 'Restart OpenSpline and reload this page to enable local Kokoro speech.';
    }
    render();
  })();
  return {
    ready,
    setBusy(value) {busy = value; render();},
    cleanup() {preview?.cleanup();},
    async generate(progress, signal) {
      await ready;
      if (!available) throw new Error(hint.textContent);
      const input = speechInput(text.value, voice.value, speed.value, limit);
      if (preview?.pending()) {
        progress('Finishing the voice preview…');
        await preview.wait();
      }
      if (signal?.aborted) throw new DOMException('Speech generation cancelled.', 'AbortError');
      progress('Generating speech locally with Kokoro…');
      return new File([await synthesize(input, signal)], 'kokoro-speech.wav', {type: 'audio/wav'});
    },
  };
}
