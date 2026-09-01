
    let currentPath = '';
    let allFiles = [];

    async function loadFiles(path) {
      if (path === undefined) path = '';
      currentPath = path;
      const listEl = document.getElementById('fileList');
      listEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Fetching files from Hugging Face Storage...</p></div>';
      
      updateBreadcrumbs(path);

      try {
        const res = await fetch('/api/list?path=' + encodeURIComponent(path));
        if (!res.ok) {
          const errData = await res.json();
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
      if (files.length === 0) {
        listEl.innerHTML = '<div class="loading-state"><p>📂 Folder is empty</p></div>';
        return;
      }

      listEl.innerHTML = files.map(function(file) {
        const isDir = file.mimeType === 'application/vnd.google-apps.folder';
        const isVideo = file.mimeType.startsWith('video/') || /\.(mp4|mkv|webm|avi|mov)$/i.test(file.name);
        const icon = isDir ? '📁' : isVideo ? '🎬' : '📄';
        const fileUrl = '/file/' + file.id + '/' + encodeURIComponent(file.name);

        let actionBtns = '';
        if (isVideo) {
          actionBtns += '<button class="btn-act play" onclick="openVideoModal('' + escapeJs(file.name) + '', '' + escapeJs(fileUrl) + '')">▶ Play</button>';
        }
        if (!isDir) {
          actionBtns += '<a href="' + fileUrl + '" class="btn-act" download>⬇</a>';
          actionBtns += '<button class="btn-act" onclick="copyLink('' + window.location.origin + fileUrl + '')">🔗</button>';
        }

        const clickHandler = isDir 
          ? "navigateTo('" + escapeJs(file.path) + "')" 
          : (isVideo ? "openVideoModal('" + escapeJs(file.name) + "', '" + escapeJs(fileUrl) + "')" : "window.open('" + fileUrl + "', '_blank')");

        return '<div class="file-row ' + (isDir ? 'is-folder' : '') + '">' +
          '<div class="col-cb">' +
            (!isDir ? '<input type="checkbox" class="item-cb" value="' + window.location.origin + fileUrl + '" onchange="updateBulkToolbar()" />' : '') +
          '</div>' +
          '<div class="file-name-cell" onclick="' + clickHandler + '">' +
            '<span class="file-icon">' + icon + '</span>' +
            '<span class="file-title">' + escapeHtml(file.name) + '</span>' +
          '</div>' +
          '<div class="file-size-cell">' + (isDir ? '-' : formatBytes(file.size)) + '</div>' +
          '<div class="file-date-cell">' + formatDate(file.modifiedTime) + '</div>' +
          '<div class="file-actions-cell">' + actionBtns + '</div>' +
        '</div>';
      }).join('');
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
      let html = '<span class="crumb" onclick="navigateTo('')">🏠 Home</span>';
      let accum = '';
      parts.forEach(function(p, idx) {
        accum += (idx === 0 ? '' : '/') + p;
        const isLast = idx === parts.length - 1;
        html += ' <span class="crumb-sep">/</span> ';
        if (isLast) {
          html += '<span class="crumb-current">' + escapeHtml(p) + '</span>';
        } else {
          html += '<span class="crumb" onclick="navigateTo('' + escapeJs(accum) + '')">' + escapeHtml(p) + '</span>';
        }
      });
      bar.innerHTML = html;
    }

    function filterFiles() {
      const q = document.getElementById('searchInput').value.toLowerCase();
      const filtered = allFiles.filter(function(f) { return f.name.toLowerCase().includes(q); });
      renderFiles(filtered);
    }

    function updateBulkToolbar() {
      const checked = document.querySelectorAll('.item-cb:checked');
      const bar = document.getElementById('bulkToolbar');
      if (!bar) return;
      if (checked.length > 0) {
        bar.style.display = 'flex';
        document.getElementById('bulkCount').textContent = checked.length + ' selected';
      } else {
        bar.style.display = 'none';
      }
    }

    function toggleSelectAll(masterCb) {
      document.querySelectorAll('.item-cb').forEach(function(cb) { cb.checked = masterCb.checked; });
      updateBulkToolbar();
    }

    function deselectAll() {
      document.querySelectorAll('.item-cb').forEach(function(cb) { cb.checked = false; });
      const master = document.getElementById('selectAllCb');
      if (master) master.checked = false;
      updateBulkToolbar();
    }

    function copySelectedLinks() {
      const selected = Array.from(document.querySelectorAll('.item-cb:checked')).map(function(cb) { return cb.value; });
      if (!selected.length) return;
      navigator.clipboard.writeText(selected.join('
')).then(function() {
        showToast('Copied ' + selected.length + ' links to clipboard! 📋');
        deselectAll();
      });
    }

    function copyLink(url) {
      navigator.clipboard.writeText(url).then(function() { showToast('Link copied to clipboard! 🔗'); });
    }

    async function downloadSelected() {
      const selected = Array.from(document.querySelectorAll('.item-cb:checked')).map(function(cb) { return cb.value; });
      if (!selected.length) return;
      showToast('Starting batch download...');
      for (let i = 0; i < selected.length; i++) {
        const a = document.createElement('a');
        a.href = selected[i];
        a.download = '';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        await new Promise(function(r) { setTimeout(r, 600); });
      }
      deselectAll();
    }

    function openVideoModal(name, url) {
      document.getElementById('modalTitle').textContent = name;
      const player = document.getElementById('videoPlayer');
      player.src = url;
      
      const fullUrl = window.location.origin + url;
      const cleanUrl = fullUrl.replace(/^https?:///, '');
      const footer = document.getElementById('modalFooter');
      footer.innerHTML = 
        '<a href="' + url + '" class="btn-player" download>⬇ Download Video</a>' +
        '<button onclick="copyLink('' + fullUrl + '')" class="btn-player">🔗 Copy Stream Link</button>' +
        '<a href="potplayer://' + fullUrl + '" class="btn-player">PotPlayer</a>' +
        '<a href="vlc://' + fullUrl + '" class="btn-player">VLC iOS/Mac</a>' +
        '<a href="iina://weblink?url=' + fullUrl + '" class="btn-player">IINA (Mac)</a>' +
        '<a href="intent://' + cleanUrl + '#Intent;action=android.intent.action.VIEW;scheme=https;type=video/*;package=org.videolan.vlc;end" class="btn-player">VLC Android</a>' +
        '<a href="intent://' + cleanUrl + '#Intent;action=android.intent.action.VIEW;scheme=https;type=video/*;package=com.mxtech.videoplayer.ad;end" class="btn-player">MX Player</a>';

      document.getElementById('videoModal').style.display = 'flex';
      player.play().catch(function() {});
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
      const gdrive_url = document.getElementById('mirrorGdriveUrl').value.trim();
      const target_path = document.getElementById('mirrorTargetPath').value.trim();
      const btn = document.getElementById('startMirrorBtn');

      btn.disabled = true;
      btn.textContent = '🚀 Dispatching Cloud Job...';

      try {
        const res = await fetch('/api/admin/mirror', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gdrive_url: gdrive_url, target_path: target_path })
        });
        const result = await res.json();
        if (res.ok && result.success) {
          alert('✅ SUCCESS!

' + result.message + '

Proses mirror sedang berjalan di GitHub Actions Cloud.');
          closeMirrorModal();
        } else {
          alert('❌ Error: ' + (result.error || 'Failed to dispatch mirror job.'));
        }
      } catch (err) {
        alert('❌ Error: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '⚡ Start Cloud Mirror (GitHub Actions)';
      }
    }

    function showToast(msg) {
      const toast = document.getElementById('toastOverlay');
      if (!toast) return;
      toast.textContent = msg;
      toast.style.display = 'block';
      setTimeout(function() { toast.style.display = 'none'; }, 3000);
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
      return (str || '').replace(/[&<>"']/g, function(m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
      });
    }

    function escapeJs(str) {
      return (str || '').replace(/\/g, '\\').replace(/'/g, "\'");
    }

    window.addEventListener('popstate', function() {
      const params = new URLSearchParams(window.location.search);
      loadFiles(params.get('p') || '');
    });

    window.onload = function() {
      if (localStorage.getItem('haruTheme') === 'light') {
        document.body.classList.add('light');
        const toggle = document.getElementById('darkToggle');
        if (toggle) toggle.textContent = '🌙';
      }
      const params = new URLSearchParams(window.location.search);
      loadFiles(params.get('p') || '');
    };
  