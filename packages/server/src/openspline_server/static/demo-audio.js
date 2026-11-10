export const VOICE_PREVIEW_TEXT = 'Hello! This is a sample of my voice. How would you like your avatar to sound?';

function clearAudio(audio) {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  audio.hidden = true;
}

export function setupVoicePreview(source, voice, speed, button, audio, message, synthesize, urls = URL) {
  let enabled = false, job, request, version = 0, objectURL;
  const cache = new Map();
  function render() {
    button.disabled = !enabled || source.value !== 'kokoro' || !!job;
    button.textContent = job ? 'Generating preview…' : 'Preview voice';
    button.setAttribute('aria-busy', String(!!job));
  }
  function stop() {
    version++;
    clearAudio(audio);
    if (objectURL) urls.revokeObjectURL(objectURL);
    objectURL = undefined;
    message.textContent = '';
  }
  source.addEventListener('change', () => {stop(); render();});
  voice.addEventListener('change', stop);
  speed.addEventListener('change', stop);
  async function preview() {
    if (!enabled || source.value !== 'kokoro' || job) return;
    stop();
    const current = version;
    const input = {text: VOICE_PREVIEW_TEXT, voice: voice.value, speed: Number(speed.value)};
    const key = JSON.stringify([input.voice, input.speed]);
    request = new AbortController();
    message.textContent = 'Generating a short voice preview…';
    job = (async () => {
      try {
        let blob = cache.get(key);
        if (!blob) {
          blob = await synthesize(input, request.signal);
          cache.set(key, blob);
          if (cache.size > 8) cache.delete(cache.keys().next().value);
        }
        if (current !== version || !enabled || source.value !== 'kokoro') return;
        objectURL = urls.createObjectURL(blob);
        audio.src = objectURL;
        audio.hidden = false;
        message.textContent = 'Voice preview. Change the voice or speed to compare.';
        try {
          await audio.play();
        } catch {
          if (current === version) message.textContent = 'Your preview is ready. Press Play to listen.';
        }
      } catch (error) {
        if (current === version && error.name !== 'AbortError') message.textContent = error.message;
      }
    })();
    render();
    try {await job;} finally {job = undefined; request = undefined; render();}
  }
  button.addEventListener('click', () => {void preview();});
  render();
  return {
    preview,
    setEnabled(value) {
      if (enabled && !value) stop();
      enabled = value;
      render();
    },
    pending() {return !!job;},
    async wait() {await job;},
    stop,
    cleanup() {stop(); request?.abort(); cache.clear();},
  };
}

export function setupAudioUpload(source, input, container, audio, urls = URL) {
  let busy = false, selected, objectURL;
  function clear() {
    clearAudio(audio);
    if (objectURL) urls.revokeObjectURL(objectURL);
    objectURL = undefined;
  }
  function render() {
    const upload = source.value === 'file';
    container.hidden = !upload;
    input.disabled = !upload || busy;
    input.required = upload;
    const file = input.files[0];
    if (file !== selected) {clear(); selected = file;}
    if (file && !objectURL) {objectURL = urls.createObjectURL(file); audio.src = objectURL;}
    audio.hidden = !upload || busy || !file;
    if (!upload || busy) audio.pause();
  }
  input.addEventListener('change', render);
  source.addEventListener('change', render);
  render();
  return {
    setBusy(value) {busy = value; render();},
    refresh: render,
    cleanup: clear,
  };
}
