// app.js — Media Gallery + AI Studio
// Photos & music are persisted locally in the browser via IndexedDB
// (so they survive refreshes without needing a database server).
// AI generation/editing is handled by the backend (/api/generate-image),
// which forwards the request to Google's Gemini API using the API key
// you enter in the AI Studio tab.

// ---------- IndexedDB setup ----------
const DB_NAME = 'mediaGalleryDB';
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const _db = e.target.result;
      if (!_db.objectStoreNames.contains('photos')) {
        _db.createObjectStore('photos', { keyPath: 'id' });
      }
      if (!_db.objectStoreNames.contains('music')) {
        _db.createObjectStore('music', { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { db = e.target.result; resolve(db); };
    req.onerror = (e) => reject(e);
  });
}

function idbAdd(storeName, item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e);
  });
}

function idbDelete(storeName, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e);
  });
}

function idbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e);
  });
}

// ---------- State ----------
let photos = [];
let music = [];
let selectedPhotoIds = new Set();
let selectedMusicIds = new Set();
let currentPlayingId = null;
let aiSourceImageFile = null;

const audioPlayer = document.getElementById('audioPlayer');

// ---------- Init ----------
(async function init() {
  await openDB();
  photos = await idbGetAll('photos');
  music = await idbGetAll('music');

  const savedKey = localStorage.getItem('api_key_google');
  if (savedKey) {
    document.getElementById('apiKeyInput').value = savedKey;
    document.getElementById('rememberKey').checked = true;
  }

  renderPhotos();
  renderMusic();
  onProviderChange();
})();

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ---------- Tabs ----------
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.getElementById('photosSection').classList.toggle('hidden', tab !== 'photos');
  document.getElementById('musicSection').classList.toggle('hidden', tab !== 'music');
  document.getElementById('aiSection').classList.toggle('hidden', tab !== 'ai');
  document.getElementById('callSection').classList.toggle('hidden', tab !== 'call');
}

// ---------- Photos ----------
async function handlePhotoUpload(event) {
  const files = Array.from(event.target.files || []);
  for (const file of files) {
    const dataUrl = await fileToDataURL(file);
    const item = { id: uid(), name: file.name, dataUrl, createdAt: Date.now() };
    photos.unshift(item);
    await idbAdd('photos', item);
  }
  event.target.value = '';
  renderPhotos();
}

function renderPhotos() {
  const gallery = document.getElementById('photoGallery');
  const empty = document.getElementById('photoEmpty');
  document.getElementById('photoCount').textContent = photos.length;

  gallery.innerHTML = '';
  if (photos.length === 0) {
    empty.classList.remove('hidden');
    gallery.classList.add('hidden');
  } else {
    empty.classList.add('hidden');
    gallery.classList.remove('hidden');
    photos.forEach(p => {
      const div = document.createElement('div');
      div.className = 'gallery-item' + (selectedPhotoIds.has(p.id) ? ' selected' : '');
      div.innerHTML = `
        <img src="${p.dataUrl}" alt="${escapeHtml(p.name)}" onclick="openLightbox('${p.id}')">
        <div class="checkbox" onclick="event.stopPropagation(); togglePhotoSelect('${p.id}')"><i class="fas fa-check"></i></div>
        <button class="delete-btn" onclick="event.stopPropagation(); deletePhoto('${p.id}')"><i class="fas fa-trash"></i></button>
      `;
      gallery.appendChild(div);
    });
  }
  updatePhotoToolbar();
}

function togglePhotoSelect(id) {
  if (selectedPhotoIds.has(id)) selectedPhotoIds.delete(id);
  else selectedPhotoIds.add(id);
  renderPhotos();
}

function toggleSelectAllPhotos() {
  if (selectedPhotoIds.size === photos.length) {
    selectedPhotoIds.clear();
  } else {
    selectedPhotoIds = new Set(photos.map(p => p.id));
  }
  renderPhotos();
}

function updatePhotoToolbar() {
  const btn = document.getElementById('deletePhotosBtn');
  const count = document.getElementById('photoSelectedCount');
  btn.classList.toggle('active', selectedPhotoIds.size > 0);
  count.textContent = selectedPhotoIds.size > 0 ? `${selectedPhotoIds.size} selected` : '';
}

async function deletePhoto(id) {
  photos = photos.filter(p => p.id !== id);
  selectedPhotoIds.delete(id);
  await idbDelete('photos', id);
  renderPhotos();
}

async function deleteSelectedPhotos() {
  if (selectedPhotoIds.size === 0) return;
  for (const id of selectedPhotoIds) {
    await idbDelete('photos', id);
  }
  photos = photos.filter(p => !selectedPhotoIds.has(p.id));
  selectedPhotoIds.clear();
  renderPhotos();
}

function openLightbox(id) {
  const p = photos.find(x => x.id === id);
  if (!p) return;
  document.getElementById('lightboxImg').src = p.dataUrl;
  document.getElementById('lightbox').classList.add('active');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.remove('active');
}

// ---------- Music ----------
async function handleMusicUpload(event) {
  const files = Array.from(event.target.files || []);
  for (const file of files) {
    const dataUrl = await fileToDataURL(file);
    const item = { id: uid(), name: file.name, dataUrl, createdAt: Date.now() };
    music.unshift(item);
    await idbAdd('music', item);
  }
  event.target.value = '';
  renderMusic();
}

function renderMusic() {
  const list = document.getElementById('musicList');
  const empty = document.getElementById('musicEmpty');
  document.getElementById('musicCount').textContent = music.length;

  list.innerHTML = '';
  if (music.length === 0) {
    empty.classList.remove('hidden');
    list.classList.add('hidden');
  } else {
    empty.classList.add('hidden');
    list.classList.remove('hidden');
    music.forEach(m => {
      const div = document.createElement('div');
      div.className = 'music-item' +
        (selectedMusicIds.has(m.id) ? ' selected' : '') +
        (currentPlayingId === m.id ? ' playing' : '');
      div.innerHTML = `
        <div class="music-checkbox" onclick="toggleMusicSelect('${m.id}')">
          <i class="fas fa-check" style="${selectedMusicIds.has(m.id) ? '' : 'display:none;'}"></i>
        </div>
        <div class="music-icon"><i class="fas fa-music"></i></div>
        <div class="music-info">
          <h4>${escapeHtml(m.name)}</h4>
          <p>${currentPlayingId === m.id ? 'Playing...' : 'Audio file'}</p>
        </div>
        <div class="music-controls">
          <button class="music-btn" onclick="togglePlayMusic('${m.id}')">
            <i class="fas ${currentPlayingId === m.id && !audioPlayer.paused ? 'fa-pause' : 'fa-play'}"></i>
          </button>
          <button class="music-btn delete" onclick="deleteMusic('${m.id}')"><i class="fas fa-trash"></i></button>
        </div>
      `;
      list.appendChild(div);
    });
  }
  updateMusicToolbar();
}

function toggleMusicSelect(id) {
  if (selectedMusicIds.has(id)) selectedMusicIds.delete(id);
  else selectedMusicIds.add(id);
  renderMusic();
}

function toggleSelectAllMusic() {
  if (selectedMusicIds.size === music.length) {
    selectedMusicIds.clear();
  } else {
    selectedMusicIds = new Set(music.map(m => m.id));
  }
  renderMusic();
}

function updateMusicToolbar() {
  const btn = document.getElementById('deleteMusicBtn');
  const count = document.getElementById('musicSelectedCount');
  btn.classList.toggle('active', selectedMusicIds.size > 0);
  count.textContent = selectedMusicIds.size > 0 ? `${selectedMusicIds.size} selected` : '';
}

function togglePlayMusic(id) {
  const m = music.find(x => x.id === id);
  if (!m) return;

  if (currentPlayingId === id && !audioPlayer.paused) {
    audioPlayer.pause();
  } else {
    audioPlayer.src = m.dataUrl;
    audioPlayer.play();
    currentPlayingId = id;
  }
  renderMusic();
}

audioPlayer.addEventListener('ended', () => {
  currentPlayingId = null;
  renderMusic();
});
audioPlayer.addEventListener('pause', renderMusic);
audioPlayer.addEventListener('play', renderMusic);

async function deleteMusic(id) {
  if (currentPlayingId === id) {
    audioPlayer.pause();
    currentPlayingId = null;
  }
  music = music.filter(m => m.id !== id);
  selectedMusicIds.delete(id);
  await idbDelete('music', id);
  renderMusic();
}

async function deleteSelectedMusic() {
  if (selectedMusicIds.size === 0) return;
  for (const id of selectedMusicIds) {
    if (currentPlayingId === id) {
      audioPlayer.pause();
      currentPlayingId = null;
    }
    await idbDelete('music', id);
  }
  music = music.filter(m => !selectedMusicIds.has(m.id));
  selectedMusicIds.clear();
  renderMusic();
}

// ---------- AI Studio: provider config ----------
const PROVIDER_INFO = {
  google: {
    note: 'Puwedeng mag-generate ng bagong larawan o mag-edit gamit ang source image.',
    keyLink: 'https://aistudio.google.com/apikey',
    showModel: false,
    showBaseUrl: false
  },
  openrouter: {
    note: 'Puwedeng mag-generate/mag-edit ng larawan. Default model: google/gemini-2.5-flash-image — puwede mong palitan sa ibaba.',
    keyLink: 'https://openrouter.ai/settings/keys',
    showModel: true,
    modelPlaceholder: 'google/gemini-2.5-flash-image',
    showBaseUrl: false
  },
  groq: {
    note: '⚠️ Walang image generation model si Groq — bibigyan ka lang ng text na paglalarawan/pagsusuri ng larawan mo, hindi bagong larawan.',
    keyLink: 'https://console.groq.com/keys',
    showModel: true,
    modelPlaceholder: 'hal. llama-3.2-90b-vision-preview',
    showBaseUrl: false
  },
  custom: {
    note: '⚠️ Text/vision analysis lang (OpenAI-compatible chat format). Ilagay ang Base URL ng provider mo (hal. Together AI, Fireworks, atbp).',
    keyLink: '',
    showModel: true,
    modelPlaceholder: 'pangalan ng model',
    showBaseUrl: true
  }
};

function onProviderChange() {
  const provider = document.getElementById('providerSelect').value;
  const info = PROVIDER_INFO[provider];

  document.getElementById('providerNote').textContent = info.note;
  document.getElementById('modelGroup').style.display = info.showModel ? 'block' : 'none';
  document.getElementById('modelInput').placeholder = info.modelPlaceholder || '';
  document.getElementById('baseUrlGroup').style.display = info.showBaseUrl ? 'block' : 'none';

  const keyLink = document.getElementById('providerKeyLink');
  if (info.keyLink) {
    keyLink.href = info.keyLink;
    keyLink.style.display = 'inline';
  } else {
    keyLink.style.display = 'none';
  }

  const savedKey = localStorage.getItem(`api_key_${provider}`);
  document.getElementById('apiKeyInput').value = savedKey || '';
  document.getElementById('rememberKey').checked = !!savedKey;
}

// ---------- AI Studio ----------
function handleAIImageSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  aiSourceImageFile = file;
  const reader = new FileReader();
  reader.onload = () => {
    document.getElementById('aiPreviewImg').src = reader.result;
    document.getElementById('aiPreviewWrap').classList.remove('hidden');
    document.getElementById('aiUploadLabel').innerHTML =
      `Napili: <strong>${escapeHtml(file.name)}</strong> — mag-e-edit ang AI base sa larawang ito`;
  };
  reader.readAsDataURL(file);
}

function clearAISourceImage() {
  aiSourceImageFile = null;
  document.getElementById('aiImageInput').value = '';
  document.getElementById('aiPreviewWrap').classList.add('hidden');
  document.getElementById('aiUploadLabel').innerHTML =
    `Click para pumili ng source image (optional para sa pag-edit)<br><small>Kung walang image, mag-ge-generate ng bagong larawan mula sa prompt</small>`;
}

async function runAIGenerate() {
  const provider = document.getElementById('providerSelect').value;
  const apiKey = document.getElementById('apiKeyInput').value.trim();
  const model = document.getElementById('modelInput').value.trim();
  const baseUrl = document.getElementById('baseUrlInput').value.trim();
  const prompt = document.getElementById('aiPrompt').value.trim();
  const remember = document.getElementById('rememberKey').checked;
  const resultBox = document.getElementById('aiResult');

  if (!apiKey) {
    showToast('Kailangan ng API key para gumana ang AI Studio.');
    return;
  }
  if (!prompt) {
    showToast('Maglagay ng prompt.');
    return;
  }
  if (provider === 'custom' && !baseUrl) {
    showToast('Kailangan ng Base URL para sa custom provider.');
    return;
  }

  if (remember) {
    localStorage.setItem(`api_key_${provider}`, apiKey);
  }

  resultBox.classList.remove('hidden');
  resultBox.innerHTML = `<div class="loading"><div class="spinner"></div> Tinatawagan ang AI...</div>`;

  try {
    const formData = new FormData();
    formData.append('provider', provider);
    formData.append('apiKey', apiKey);
    formData.append('prompt', prompt);
    if (model) formData.append('model', model);
    if (baseUrl) formData.append('baseUrl', baseUrl);
    if (aiSourceImageFile) {
      formData.append('image', aiSourceImageFile);
    }

    const resp = await fetch('/api/generate-image', {
      method: 'POST',
      body: formData
    });
    const data = await resp.json();

    if (!resp.ok) {
      resultBox.innerHTML = `<p class="ai-error"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(data.error || 'May error na nangyari.')}</p>`;
      return;
    }

    if (data.image) {
      const resultId = uid();
      resultBox.innerHTML = `
        ${data.text ? `<p class="ai-text">${escapeHtml(data.text)}</p>` : ''}
        <img src="${data.image}" id="aiResultImg-${resultId}" alt="AI result">
        <button class="btn btn-primary" onclick="saveAIResultToGallery('${resultId}')">
          <i class="fas fa-save"></i> I-save sa Gallery
        </button>
      `;
    } else {
      // Text-only response (e.g. Groq / custom vision analysis — no image generated)
      resultBox.innerHTML = `<p class="ai-text" style="white-space:pre-wrap;">${escapeHtml(data.text || 'Walang laman ang sagot.')}</p>`;
    }
  } catch (err) {
    resultBox.innerHTML = `<p class="ai-error"><i class="fas fa-exclamation-triangle"></i> ${escapeHtml(err.message)}</p>`;
  }
}

async function saveAIResultToGallery(resultId) {
  const img = document.getElementById(`aiResultImg-${resultId}`);
  if (!img) return;
  const item = { id: uid(), name: `ai-generated-${Date.now()}.png`, dataUrl: img.src, createdAt: Date.now() };
  photos.unshift(item);
  await idbAdd('photos', item);
  renderPhotos();
  showToast('Na-save sa Pictures gallery!');
}

// ---------- Utils ----------
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Expose functions used by inline onclick handlers
window.switchTab = switchTab;
window.handlePhotoUpload = handlePhotoUpload;
window.togglePhotoSelect = togglePhotoSelect;
window.toggleSelectAllPhotos = toggleSelectAllPhotos;
window.deletePhoto = deletePhoto;
window.deleteSelectedPhotos = deleteSelectedPhotos;
window.openLightbox = openLightbox;
window.closeLightbox = closeLightbox;
window.handleMusicUpload = handleMusicUpload;
window.toggleMusicSelect = toggleMusicSelect;
window.toggleSelectAllMusic = toggleSelectAllMusic;
window.togglePlayMusic = togglePlayMusic;
window.deleteMusic = deleteMusic;
window.deleteSelectedMusic = deleteSelectedMusic;
window.handleAIImageSelect = handleAIImageSelect;
window.clearAISourceImage = clearAISourceImage;
window.runAIGenerate = runAIGenerate;
window.saveAIResultToGallery = saveAIResultToGallery;
