
let currentPath = '';
let allFiles = [];

async function loadFiles(path) {
  if (path === undefined || path === null) path = '';
  currentPath = path;
  const listEl = document.getElementById('fileList');
  if (!listEl) return;
  listEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Fetching files from Hugging Face Storage...</p></div>';
  
  updateBreadcrumbs(path);

  try {
    const res = await fetch('/api/list?path=' + encodeURIComponent(path));
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || 'Failed to fetch directory');
    }
    const data = await res.json();
    allFiles = data.files || [];
    renderFiles(allFiles);
  } catch (e) {
    listEl.innerHTML = '<div class="loading-state" style="color:#ef4444;"><p>❌ Error: ' + escapeHtml(e.message) + '</p></div>';
  }
}

function renderFiles(files) {
  const listEl = document.getElementById('fileList');
  if (!listEl) return;
  if (!files || files.length === 0) {
    listEl.innerHTML = '<div class="loading-state"><p>📂 Folder is empty</p></div>';
    return;
  }

  let html = '';
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const isDir = file.mimeType === 'application/vnd.google-apps.folder';
    const isVideo = (file.mimeType && file.mimeType.startsWith('video/')) || /\.(mp4|mkv|webm|avi|mov)$/i.test(file.name);
    const icon = isDir ? '📁' : (isVideo ? '🎬' : '📄');
    const fileUrl = '/file/' + file.id + '/' + encodeURIComponent(file.name);

    let actionBtns = '';
    if (isVideo) {
      actionBtns += '<button class="btn-act play" data-name="' + encodeURIComponent(file.name) + '" data-url="' + encodeURIComponent(fileUrl) + '" onclick="handlePlayClick(this)">▶ Play</button>';
    }
    if (!isDir) {
      actionBtns += '<a href="' + fileUrl + '" class="btn-act" download>⬇</a>';
      actionBtns += '<button class="btn-act" data-url="' + window.location.origin + fileUrl + '" onclick="handleCopyClick(this)">🔗</button>';
    }

    const clickAttr = isDir 
      ? 'data-path="' + encodeURIComponent(file.path) + '" onclick="handleFolderClick(this)"'
      : (isVideo ? 'data-name="' + encodeURIComponent(file.name) + '" data-url="' + encodeURIComponent(fileUrl) + '" onclick="handlePlayClick(this)"' : 'data-url="' + fileUrl + '" onclick="window.open(this.dataset.url, \'_blank\')"');

    html += '<div class="file-row ' + (isDir ? 'is-folder' : '') + '">' +
      '<div class="col-cb">' +
        (!isDir ? '<input type="checkbox" class="item-cb" value="' + window.location.origin + fileUrl + '" onchange="updateBulkToolbar()" />' : '') +
      '</div>' +
      '<div class="file-name-cell" ' + clickAttr + '>' +
        '<span class="file-icon">' + icon + '</span>' +
        '<span class="file-title">' + escapeHtml(file.name) + '</span>' +
      '</div>' +
      '<div class="file-size-cell">' + (isDir ? '-' : formatBytes(file.size)) + '</div>' +
      '<div class="file-date-cell">' + formatDate(file.modifiedTime) + '</div>' +
      '<div class="file-actions-cell">' + actionBtns + '</div>' +
    '</div>';
  }
  listEl.innerHTML = html;
}

function handleFolderClick(el) {
  const path = decodeURIComponent(el.dataset.path || '');
  navigateTo(path);
}

function handlePlayClick(el) {
  const name = decodeURIComponent(el.dataset.name || '');
  const url = decodeURIComponent(el.dataset.url || '');
  openVideoModal(name, url);
}

function handleCopyClick(el) {
  const url = el.dataset.url || '';
  copyLink(url);
}

function navigateTo(path) {
  window.history.pushState(null, '', path ? '?p=' + encodeURIComponent(path) : '/');
  loadFiles(path);
}

function updateBreadcrumbs(path) {
  const bar = document.getElementById('breadcrumbBar');
  if (!bar) return;
  if (!path) {
    bar.innerHTML = '<span class="crumb-current">🏠 Home</span>';
    return;
  }
  const parts = path.split('/');
  let html = '<span class="crumb" onclick="navigateTo(\'\')">🏠 Home</span>';
  let accum = '';
  for (let idx = 0; idx < parts.length; idx++) {
    const p = parts[idx];
    accum += (idx === 0 ? '' : '/') + p;
    const isLast = idx === parts.length - 1;
    html += ' <span class="crumb-sep">/</span> ';
    if (isLast) {
      html += '<span class="crumb-current">' + escapeHtml(p) + '</span>';
    } else {
      html += '<span class="crumb" data-target="' + encodeURIComponent(accum) + '" onclick="navigateTo(decodeURIComponent(this.dataset.target))">' + escapeHtml(p) + '</span>';
    }
  }
  bar.innerHTML = html;
}

function filterFiles() {
  const input = document.getElementById('searchInput');
  if (!input) return;
  const q = input.value.toLowerCase();
  const filtered = allFiles.filter(f => f.name.toLowerCase().includes(q));
  renderFiles(filtered);
}

function updateBulkToolbar() {
  const checked = document.querySelectorAll('.item-cb:checked');
  const bar = document.getElementById('bulkToolbar');
  if (!bar) return;
  if (checked.length > 0) {
    bar.style.display = 'flex';
    const countEl = document.getElementById('bulkCount');
    if (countEl) countEl.textContent = checked.length + ' selected';
  } else {
    bar.style.display = 'none';
  }
}

function toggleSelectAll(masterCb) {
  document.querySelectorAll('.item-cb').forEach(cb => { cb.checked = masterCb.checked; });
  updateBulkToolbar();
}

function deselectAll() {
  document.querySelectorAll('.item-cb').forEach(cb => { cb.checked = false; });
  const master = document.getElementById('selectAllCb');
  if (master) master.checked = false;
  updateBulkToolbar();
}

function copySelectedLinks() {
  const selected = Array.from(document.querySelectorAll('.item-cb:checked')).map(cb => cb.value);
  if (!selected.length) return;
  navigator.clipboard.writeText(selected.join('\n')).then(() => {
    showToast('Copied ' + selected.length + ' links to clipboard! 📋');
    deselectAll();
  });
}

function copyLink(url) {
  navigator.clipboard.writeText(url).then(() => { showToast('Link copied to clipboard! 🔗'); });
}

async function downloadSelected() {
  const selected = Array.from(document.querySelectorAll('.item-cb:checked')).map(cb => cb.value);
  if (!selected.length) return;
  showToast('Starting batch download...');
  for (let i = 0; i < selected.length; i++) {
    const a = document.createElement('a');
    a.href = selected[i];
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    await new Promise(r => setTimeout(r, 600));
  }
  deselectAll();
}

function openVideoModal(name, url) {
  const titleEl = document.getElementById('modalTitle');
  if (titleEl) titleEl.textContent = name;
  const player = document.getElementById('videoPlayer');
  if (player) {
    player.src = url;
    player.play().catch(() => {});
  }
  
  const fullUrl = window.location.origin + url;
  const cleanUrl = fullUrl.replace(/^https?:\/\//, '');
  const footer = document.getElementById('modalFooter');
  if (footer) {
    footer.innerHTML = 
      '<a href="' + url + '" class="btn-player" download>⬇ Download Video</a>' +
      '<button class="btn-player" data-url="' + fullUrl + '" onclick="handleCopyClick(this)">🔗 Copy Stream Link</button>' +
      '<a href="potplayer://' + fullUrl + '" class="btn-player">PotPlayer</a>' +
      '<a href="vlc://' + fullUrl + '" class="btn-player">VLC iOS/Mac</a>' +
      '<a href="iina://weblink?url=' + fullUrl + '" class="btn-player">IINA (Mac)</a>' +
      '<a href="intent://' + cleanUrl + '#Intent;action=android.intent.action.VIEW;scheme=https;type=video/*;package=org.videolan.vlc;end" class="btn-player">VLC Android</a>' +
      '<a href="intent://' + cleanUrl + '#Intent;action=android.intent.action.VIEW;scheme=https;type=video/*;package=com.mxtech.videoplayer.ad;end" class="btn-player">MX Player</a>';
  }

  const modal = document.getElementById('videoModal');
  if (modal) modal.style.display = 'flex';
}

function closeModal() {
  const modal = document.getElementById('videoModal');
  if (modal) modal.style.display = 'none';
  const player = document.getElementById('videoPlayer');
  if (player) {
    player.pause();
    player.src = '';
  }
}

function openMirrorModal() {
  const m = document.getElementById('mirrorModal');
  if (m) m.style.display = 'flex';
}
function closeMirrorModal() {
  const m = document.getElementById('mirrorModal');
  if (m) m.style.display = 'none';
}

async function submitCloudMirror(e) {
  e.preventDefault();
  const gdriveInput = document.getElementById('mirrorGdriveUrl');
  const targetInput = document.getElementById('mirrorTargetPath');
  const gdrive_url = gdriveInput ? gdriveInput.value.trim() : '';
  const target_path = targetInput ? targetInput.value.trim() : '';
  const btn = document.getElementById('startMirrorBtn');

  if (btn) {
    btn.disabled = true;
    btn.textContent = '🚀 Dispatching Cloud Job...';
  }

  try {
    const res = await fetch('/api/admin/mirror', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gdrive_url: gdrive_url, target_path: target_path })
    });
    const result = await res.json();
    if (res.ok && result.success) {
      alert('✅ SUCCESS!\n\n' + result.message + '\n\nProses mirror sedang berjalan di GitHub Actions Cloud.');
      closeMirrorModal();
    } else {
      alert('❌ Error: ' + (result.error || 'Failed to dispatch mirror job.'));
    }
  } catch (err) {
    alert('❌ Error: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ Start Cloud Mirror (GitHub Actions)';
    }
  }
}

function showToast(msg) {
  const toast = document.getElementById('toastOverlay');
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

function toggleDark() {
  const isLight = document.body.classList.toggle('light');
  localStorage.setItem('haruTheme', isLight ? 'light' : 'dark');
  const toggle = document.getElementById('darkToggle');
  if (toggle) toggle.textContent = isLight ? '🌙' : '☀️';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// History back/forward navigation
window.addEventListener('popstate', () => {
  const params = new URLSearchParams(window.location.search);
  loadFiles(params.get('p') || '');
});

// Initialization
function initHaruDrive() {
  if (localStorage.getItem('haruTheme') === 'light') {
    document.body.classList.add('light');
    const toggle = document.getElementById('darkToggle');
    if (toggle) toggle.textContent = '🌙';
  }
  const params = new URLSearchParams(window.location.search);
  loadFiles(params.get('p') || '');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHaruDrive);
} else {
  initHaruDrive();
}
