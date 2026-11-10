import{registerAvatarElement}from'./browser/element.js';registerAvatarElement();
import{waitForPlayback}from'./playback-ready.js';
import{prepareDemoQuality}from'./demo-quality.js';
import{setupGpuPicker}from'./demo-gpus.js';
import{setupDemoCredentials}from'./demo-credentials.js';
import{setupDemoExamples}from'./demo-examples.js';
import{createDemoRecording}from'./demo-recording.js';
import{setupLocalSpeech}from'./demo-tts.js';
import{setupAudioUpload}from'./demo-audio.js';
import{setupPortraitCrop}from'./demo-portrait.js?v=7';
const $=id=>document.getElementById(id);let session,ws,media,context,worklet,downloadURL,speechURL,speechAbort,recording,playbackAbort,stopping,playbackError,providerNotice;
const portrait=setupPortraitCrop($('portrait'),{preview:$('portrait-preview'),empty:$('empty'),canvas:$('portrait-crop'),grid:$('crop-grid'),controls:$('portrait-controls'),actions:$('crop-actions'),edit:$('crop-edit'),original:$('crop-original'),editor:$('crop-editor'),zoom:$('crop-zoom'),zoomValue:$('crop-zoom-value'),horizontal:$('crop-horizontal'),vertical:$('crop-vertical'),apply:$('crop-apply'),cancel:$('crop-cancel'),reset:$('crop-reset'),message:$('portrait-message')});
const localSpeech=setupLocalSpeech(request,$('source'),{fieldset:$('tts-settings'),text:$('tts-text'),voice:$('tts-voice'),speed:$('tts-speed'),hint:$('tts-hint'),count:$('tts-count'),start:$('start'),previewButton:$('tts-preview-button'),previewAudio:$('tts-preview-audio'),previewMessage:$('tts-preview-message')});
const audioUpload=setupAudioUpload($('source'),$('audio'),$('audio-label'),$('uploaded-audio-preview'));
setupDemoExamples($('source'),$('example-title'),$('example-description'),$('example-code'),$('example-link'),$('copy-example'),$('copy-status'));
const credentialsReady=setupDemoCredentials(request,$('source'),$('api-key-field'),$('api-key-label'),$('api-key'),$('api-key-hint'),{container:$('agent-id-field'),input:$('agent-id'),hint:$('agent-id-hint')});
const gpuReady=fetch('/readyz').then(r=>r.json()).then(data=>{
 $('health').textContent=data.backend==='test'?'Test backend · static portrait':data.workers.some(w=>w.ready)?'GPU ready':'Worker unavailable';
 const qualities=data.demo_qualities??data.workers.map(w=>w.quality);
 for(const option of $('quality').options)option.disabled=!qualities.includes(option.value);
 if(data.workers.length===1)$('quality').value=data.workers[0].quality;
 if(!qualities.includes($('quality').value))$('quality').value=qualities[0]??'low';
}).catch(()=>{$('health').textContent='Service unavailable';}).then(()=>setupGpuPicker(request,$('quality'),$('gpu-settings'),$('gpu-list'),$('gpu-hint')));
function clearDownload(){if(downloadURL)URL.revokeObjectURL(downloadURL);downloadURL=null;$('download').hidden=true;$('download').removeAttribute('href');if(speechURL)URL.revokeObjectURL(speechURL);speechURL=null;$('speech-download').hidden=true;$('speech-download').removeAttribute('href');}
async function request(path,init={}){const r=await fetch(path,init);if(!r.ok)throw new Error((await r.json()).error?.message??r.statusText);return r.status===204?null:r.json();}
let sequence=0;const pending=new Map();function send(type,body={}){const id=String(++sequence);return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({type,id,...body}));});}
function connect(path,token,apiKey,agentId){return new Promise((resolve,reject)=>{
 const socket=ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}${path}`);
 const fail=message=>{
  if(ws!==socket)return;
  playbackError=new Error(message);$('status').textContent=message;reject(playbackError);
  for(const p of pending.values())p.reject(playbackError);pending.clear();
  if(session)void stop(false);
 };
 socket.onopen=()=>socket.send(JSON.stringify({token,api_key:apiKey,agent_id:agentId}));
 socket.onerror=()=>fail('Voice connection failed. Start a new session.');
 socket.onclose=()=>fail(playbackError?.message??'Voice connection closed. Start a new session.');
 socket.onmessage=({data})=>{
  if(ws!==socket)return;
  const e=JSON.parse(data);
  if(e.type==='ready')resolve();
  if(e.type==='warning'){providerNotice=e.message;$('status').textContent=e.message;return;}
  if(e.type==='provider_status'){providerNotice=null;$('status').textContent=e.message;return;}
  if(e.type==='error'){
   if(e.fatal||!e.id){fail(e.message);return;}
   const p=pending.get(e.id);if(p){p.reject(new Error(e.message));pending.delete(e.id);}
   $('status').textContent=e.message;
  }else if(pending.has(e.id)){pending.get(e.id).resolve(e);pending.delete(e.id);}
 };
});}
$('setup').onsubmit=async e=>{e.preventDefault();localSpeech.setBusy(true);audioUpload.setBusy(true);portrait.setBusy(true);$('source').disabled=true;$('quality').disabled=true;$('gpu-settings').disabled=true;$('status').textContent='Preparing your avatar…';let gpuPicker;try{
 if(session)await stop(false);
 clearDownload();
 playbackError=providerNotice=null;
 const credentials=await credentialsReady;
 const portraitFile=await portrait.file();
 const source=$('source').value,quality=$('quality').value;let file=$('audio').files[0];
 const fileSource=source==='file'||source==='kokoro';
 gpuPicker=await gpuReady;
 const apiKey=credentials.key(source),agentId=credentials.agentId(source);
 gpuPicker.lock(true);const devices=gpuPicker.devices();
 if(source==='file'&&!file)throw new Error('Upload a speech recording for your avatar.');
 if(source==='kokoro'){
   speechAbort=new AbortController();
   file=await localSpeech.generate(message=>{$('status').textContent=message;},speechAbort.signal);
   speechAbort=null;
   speechURL=URL.createObjectURL(file);$('speech-download').href=speechURL;$('speech-download').hidden=false;
 }
 const form=new FormData();form.set('portrait',portraitFile);form.set('quality',quality);
 await prepareDemoQuality(request,quality,message=>{$('status').textContent=message;},{devices});
 await gpuPicker.refresh().catch(()=>{});
 $('status').textContent='Preparing your avatar…';
 session=await request('/v1/sessions',{method:'POST',body:form});
 $('status').textContent='Connecting playback…';playbackAbort=new AbortController();
 const playbackReady=waitForPlayback($('avatar'),{signal:playbackAbort.signal,onBlocked:()=>{$('status').textContent='Click Enable playback on the avatar to continue.';}});playbackReady.catch(()=>{});
 const activeAvatar=$('avatar'),activeSession=session;
 activeAvatar.addEventListener('avatarerror',e=>{if(session!==activeSession||$('avatar')!==activeAvatar)return;playbackError=e.detail instanceof Error?e.detail:new Error(String(e.detail));$('status').textContent=playbackError.message;void stop(false);},{once:true});
 $('avatar').session={id:session.id,url:location.origin,token:session.token,transport:'websocket'};$('avatar').hidden=false;portrait.setPlaying(true);$('stop').hidden=false;
 await connect(`/v1/sessions/${session.id}/${fileSource?'audio':'demo/'+source}`,session.publisher_token,apiKey,agentId);
 await playbackReady;
 if(fileSource){
   let recordingError;
   try{recording=createDemoRecording(activeAvatar.connection);}catch(error){recordingError=error;}
   $('status').textContent='Generating synchronized audio and video…';const audio=new FormData();audio.set('audio',file);await request(`/v1/sessions/${session.id}/file`,{method:'POST',headers:{Authorization:`Bearer ${session.publisher_token}`},body:audio});
   if(session!==activeSession)return;
   await send('end_turn');
   if(session!==activeSession)return;
   if(recording){
     try{const video=await recording.finish();if(session===activeSession){downloadURL=URL.createObjectURL(video);$('download').href=downloadURL;$('download').download='openspline-video.'+(video.type.startsWith('video/mp4')?'mp4':'webm');$('download').hidden=false;}}
     catch(error){recordingError=error;}
     finally{recording=null;}
   }
   if(session!==activeSession)return;
   $('status').textContent=recordingError?`Playback complete. Video download unavailable: ${recordingError.message}`:'Playback complete. Download your video or start another session.';
 }else{
   media=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true}});if(session!==activeSession){media.getTracks().forEach(t=>t.stop());throw playbackError??new Error('Session ended.');}context=new AudioContext({sampleRate:24000});await context.audioWorklet.addModule('/static/microphone.js');if(session!==activeSession)throw playbackError??new Error('Session ended.');worklet=new AudioWorkletNode(context,'pcm-capture');context.createMediaStreamSource(media).connect(worklet);worklet.port.onmessage=({data})=>{if(ws?.readyState===WebSocket.OPEN&&ws.bufferedAmount<100000)ws.send(data);};worklet.connect(context.destination);$('status').textContent=providerNotice??'Connected. Speak naturally; interrupt at any time.';
 }
}catch(error){$('status').textContent=(playbackError??error).message;await stop(false);}finally{localSpeech.setBusy(false);audioUpload.setBusy(false);portrait.setBusy(false);$('source').disabled=false;$('quality').disabled=false;gpuPicker?.lock(false);}};
async function stop(message=true){
 if(stopping)return stopping;
 stopping=(async()=>{
  speechAbort?.abort();speechAbort=null;playbackAbort?.abort();recording?.cancel();recording=null;media?.getTracks().forEach(t=>t.stop());worklet?.disconnect();const socket=ws;ws=null;socket?.close();await context?.close();context=null;
  if(session){const old=session;session=null;await request(`/v1/sessions/${old.id}`,{method:'DELETE',headers:{Authorization:`Bearer ${old.publisher_token}`}}).catch(()=>{});}
  $('avatar')?.remove();const el=document.createElement('openspline-avatar');el.id='avatar';el.hidden=true;$('preview').append(el);portrait.setPlaying(false);$('stop').hidden=true;if(message)$('status').textContent='Session ended.';
 })();try{await stopping;}finally{stopping=null;}
}
$('stop').onclick=()=>void stop();window.addEventListener('pagehide',()=>{speechAbort?.abort();localSpeech.cleanup();audioUpload.cleanup();portrait.cleanup();recording?.cancel();if(downloadURL)URL.revokeObjectURL(downloadURL);if(speechURL)URL.revokeObjectURL(speechURL);media?.getTracks().forEach(t=>t.stop());ws?.close();});window.addEventListener('pageshow',()=>{audioUpload.refresh();portrait.refresh();});

