const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const initialCrop = () => ({zoom: 1, x: .5, y: .5});

// Positions describe the crop's travel across the original, oriented image.
export function portraitCrop(width, height, {zoom = 1, x = .5, y = .5} = {}) {
  const size = Math.min(width, height) / clamp(zoom, 1, 4);
  return {x: (width - size) * clamp(x, 0, 1), y: (height - size) * clamp(y, 0, 1), size};
}

export function movePortraitCrop(width, height, state, dx, dy) {
  const crop = portraitCrop(width, height, state);
  return {...state,
    x: width > crop.size ? clamp((crop.x + dx) / (width - crop.size), 0, 1) : .5,
    y: height > crop.size ? clamp((crop.y + dy) / (height - crop.size), 0, 1) : .5,
  };
}

export function zoomPortraitCrop(width, height, state, zoom) {
  const crop = portraitCrop(width, height, state);
  const next = {...state, zoom: clamp(zoom, 1, 4)};
  const size = portraitCrop(width, height, next).size;
  return {...next,
    x: width > size ? clamp((crop.x + (crop.size - size) / 2) / (width - size), 0, 1) : .5,
    y: height > size ? clamp((crop.y + (crop.size - size) / 2) / (height - size), 0, 1) : .5,
  };
}

function loadImage(url) {
  const image = new Image();
  image.src = url;
  // Image decoding uses the file's EXIF orientation in current Mac browsers.
  return image.decode().then(() => image);
}

export function setupPortraitCrop(input, ui, {decode = loadImage, urls = URL, makeFile = (blob, name) => new File([blob], name, {type: 'image/png'})} = {}) {
  let image, source, originalURL, croppedURL, croppedFile, appliedState, state = initialCrop();
  let loading, committing, failure, editing = false, busy = false, playing = false, version = 0, drag;
  const locked = () => busy || playing || !!loading || !!committing;
  const dimensions = () => [image.naturalWidth, image.naturalHeight];

  function draw() {
    const crop = portraitCrop(...dimensions(), state);
    const context = ui.canvas.getContext('2d');
    // Flatten transparency consistently in both the preview and uploaded crop.
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 512, 512);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, crop.x, crop.y, crop.size, crop.size, 0, 0, 512, 512);
    ui.zoom.value = state.zoom;
    ui.zoomValue.textContent = `${state.zoom.toFixed(2)}×`;
    ui.zoom.setAttribute('aria-valuetext', `${state.zoom.toFixed(2)} times`);
    ui.horizontal.value = state.x * 100;
    ui.vertical.value = state.y * 100;
    ui.horizontal.disabled = locked() || image.naturalWidth - crop.size < .01;
    ui.vertical.disabled = locked() || image.naturalHeight - crop.size < .01;
    ui.message.textContent = crop.size < 512
      ? 'This crop enlarges a small area; fine details may look softer. Keep the hair and chin inside the square.'
      : 'Keep the hair and chin inside the square. This framing will be used when you click Speak.';
  }

  function render() {
    const disabled = locked();
    input.disabled = disabled;
    ui.controls.hidden = !image && !failure && !loading;
    ui.actions.hidden = !image || editing;
    ui.edit.disabled = disabled;
    ui.edit.textContent = croppedFile ? 'Adjust crop' : 'Crop portrait';
    ui.original.hidden = !croppedFile;
    ui.original.disabled = disabled;
    ui.editor.hidden = !editing || playing;
    ui.editor.disabled = disabled;
    ui.apply.textContent = committing ? 'Saving crop…' : 'Use this crop';
    ui.canvas.hidden = !editing || !image || playing;
    ui.grid.hidden = ui.canvas.hidden;
    ui.canvas.setAttribute('aria-disabled', String(disabled));
    ui.canvas.tabIndex = disabled ? -1 : 0;
    ui.preview.hidden = !image || editing || playing;
    ui.empty.hidden = !!image || playing;
    if (image && !editing) ui.preview.src = croppedURL || originalURL;
    if (failure) ui.message.textContent = failure.message;
    else if (loading) ui.message.textContent = 'Loading portrait…';
    else if (playing) ui.message.textContent = 'End the session to adjust your portrait.';
    else if (editing && image) draw();
    else ui.message.textContent = croppedFile
      ? 'Cropped portrait ready. Click Speak to use this framing.'
      : 'Use Crop portrait to zoom in and frame the face. The full photo is used until you choose a crop.';
  }

  function clearCrop() {
    if (croppedURL) urls.revokeObjectURL(croppedURL);
    croppedURL = croppedFile = appliedState = undefined;
    state = initialCrop();
    editing = false;
    drag = undefined;
  }

  async function select() {
    const current = ++version;
    const file = input.files[0];
    clearCrop();
    if (originalURL) urls.revokeObjectURL(originalURL);
    originalURL = undefined;
    image = source = failure = loading = committing = undefined;
    if (!file) {render(); return;}
    let url;
    const job = (async () => {
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error('Portrait limit is 10 MB. Choose a smaller image.');
        url = urls.createObjectURL(file);
        const decoded = await decode(url);
        if (current !== version) return;
        if (!decoded.naturalWidth || !decoded.naturalHeight) throw new Error('The portrait has no image pixels.');
        if (decoded.naturalWidth * decoded.naturalHeight > 16_000_000) throw new Error('Portrait limit is 16 megapixels. Choose a smaller image.');
        image = decoded;
        source = file;
        originalURL = url;
      } catch (error) {
        if (current === version) failure = new Error(error.message.startsWith('Portrait limit') ? error.message : 'Could not open this portrait. Choose a JPG, PNG or WebP image.');
      } finally {
        if (url && url !== originalURL) urls.revokeObjectURL(url);
      }
    })();
    loading = job;
    render();
    await job;
    if (current === version) {loading = undefined; render();}
  }

  function edit() {
    if (locked() || !image) return;
    state = appliedState ? {...appliedState} : initialCrop();
    failure = undefined;
    editing = true;
    render();
    ui.canvas.focus();
  }

  async function apply() {
    if (committing) return committing;
    if (!editing || !image) return;
    const current = version;
    const selectedState = {...state};
    const job = (async () => {
      const blob = await new Promise((resolve, reject) => {
        ui.canvas.toBlob(value => value ? resolve(value) : reject(new Error('Could not save the crop. Please try again.')), 'image/png');
      });
      if (current !== version) throw new Error('The portrait changed. Please choose your crop again.');
      const file = makeFile(blob, `${source.name.replace(/\.[^.]+$/, '') || 'portrait'}-crop.png`);
      if (croppedURL) urls.revokeObjectURL(croppedURL);
      croppedFile = file;
      croppedURL = urls.createObjectURL(file);
      appliedState = selectedState;
      editing = false;
      failure = undefined;
      drag = undefined;
    })();
    committing = job;
    render();
    try {await job;} catch (error) {if (current === version) failure = error; throw error;}
    finally {if (current === version) {committing = undefined; render();}}
  }

  input.addEventListener('change', () => {void select();});
  ui.edit.addEventListener('click', edit);
  ui.original.addEventListener('click', () => {if (!locked()) {clearCrop(); failure = undefined; render();}});
  ui.apply.addEventListener('click', () => {if (!locked()) void apply().catch(() => {});});
  ui.cancel.addEventListener('click', () => {if (!locked()) {editing = false; failure = undefined; drag = undefined; render();}});
  ui.reset.addEventListener('click', () => {if (!locked()) {state = initialCrop(); draw();}});
  ui.zoom.addEventListener('input', () => {
    if (locked() || !editing) return;
    state = zoomPortraitCrop(...dimensions(), state, Number(ui.zoom.value));
    draw();
  });
  for (const [control, axis] of [[ui.horizontal, 'x'], [ui.vertical, 'y']]) {
    control.addEventListener('input', () => {
      if (locked() || !editing) return;
      state = {...state, [axis]: clamp(Number(control.value) / 100, 0, 1)};
      draw();
    });
  }
  ui.canvas.addEventListener('pointerdown', event => {
    if (locked() || !editing || drag || event.button !== 0) return;
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY};
    ui.canvas.setPointerCapture(event.pointerId);
    ui.canvas.focus();
  });
  ui.canvas.addEventListener('pointermove', event => {
    if (locked() || !editing || drag?.id !== event.pointerId) return;
    const bounds = ui.canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const crop = portraitCrop(...dimensions(), state);
    state = movePortraitCrop(...dimensions(), state, -(event.clientX - drag.x) * crop.size / bounds.width, -(event.clientY - drag.y) * crop.size / bounds.height);
    drag = {id: event.pointerId, x: event.clientX, y: event.clientY};
    draw();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    ui.canvas.addEventListener(type, event => {if (drag?.id === event.pointerId) drag = undefined;});
  }
  ui.canvas.addEventListener('keydown', event => {
    if (locked() || !editing) return;
    const direction = {ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1]}[event.key];
    if (!direction) return;
    event.preventDefault();
    const step = portraitCrop(...dimensions(), state).size * (event.shiftKey ? .1 : .02);
    state = movePortraitCrop(...dimensions(), state, direction[0] * step, direction[1] * step);
    draw();
  });
  render();
  if (input.files[0]) void select();
  return {
    async file() {
      await loading;
      if (failure) throw failure;
      if (!source) throw new Error('Choose a portrait for your avatar.');
      // Speak also commits a visible draft, so it always uses the displayed crop.
      if (editing) await apply();
      return croppedFile || source;
    },
    setBusy(value) {busy = value; drag = undefined; render();},
    setPlaying(value) {playing = value; render();},
    refresh() {if (input.files[0] !== source && !loading) void select(); else render();},
    async wait() {await loading; await committing;},
    cleanup() {
      version++;
      clearCrop();
      if (originalURL) urls.revokeObjectURL(originalURL);
      originalURL = image = source = loading = committing = undefined;
    },
  };
}
