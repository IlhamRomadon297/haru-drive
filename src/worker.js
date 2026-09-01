export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Reliable Environment Secrets with In-Code Defaults
    const HF_REPO_ID = env.HF_REPO_ID || 'harumidesu/harudrive-data';
    const HF_TOKEN = env.HF_TOKEN || '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';
    const APP_PASSWORD = env.APP_PASSWORD || 'HaruDrive_Desu';
    const ADMIN_PIN = env.ADMIN_PIN || '290722';
    const GITHUB_PAT = env.GITHUB_PAT || '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';
    const GITHUB_REPO = env.GITHUB_REPO || 'IlhamRomadon297/haru-drive';

    // Authentication Check
    const cookie = request.headers.get('Cookie') || '';
    const isLoggedIn = cookie.includes('harudrive_auth=true');

    // Handle Login Submit
    if (url.pathname === '/login' && request.method === 'POST') {
      const formData = await request.formData();
      const password = formData.get('password');
      if (password === APP_PASSWORD) {
        return new Response('Logged in', {
          status: 302,
          headers: {
            'Location': '/',
            'Set-Cookie': 'harudrive_auth=true; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000'
          }
        });
      } else {
        return new Response(htmlPage(loginUI('Incorrect password. Please try again.'), env), {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }
    }

    // Public / Protected Route rules
    const isPublicRoute = url.pathname.startsWith('/file/') ||
                          url.pathname.startsWith('/raw/') ||
                          (url.pathname === '/api/list' && url.searchParams.has('path'));

    if (!isLoggedIn && !isPublicRoute) {
      if (url.pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(htmlPage(loginUI(), env), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // Handle Logout
    if (url.pathname === '/logout') {
      return new Response('Logged out', {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': 'harudrive_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
        }
      });
    }

    // ==========================================
    // API: Realtime Global Search (D1 Database)
    // ==========================================
    if (url.pathname === '/api/search') {
      try {
        const q = (url.searchParams.get('q') || '').trim();
        if (!q) {
          return new Response(JSON.stringify({ query: '', files: [] }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        if (!env.harudrive_db) {
          return new Response(JSON.stringify({ error: 'D1 database not bound' }), { status: 500 });
        }

        const stmt = env.harudrive_db.prepare(
          'SELECT short_id, file_path, name, type, size FROM shortlinks WHERE name LIKE ? ORDER BY name ASC LIMIT 60'
        );
        const { results } = await stmt.bind(`%${q}%`).all();

        const formattedResults = (results || []).map(row => {
          const isDir = row.type === 'folder';
          const pathParts = (row.file_path || '').split('/');
          pathParts.pop();
          const parentDir = pathParts.join('/');

          return {
            id: row.short_id,
            path: row.file_path,
            name: row.name,
            mimeType: isDir ? 'application/vnd.google-apps.folder' : getMimeType(row.name),
            size: row.size || 0,
            modifiedTime: new Date().toISOString(),
            parentDir: parentDir
          };
        });

        return new Response(JSON.stringify({ query: q, files: formattedResults }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // ==========================================
    // API: List Folder Files from Hugging Face
    // ==========================================
    if (url.pathname === '/api/list') {
      try {
        let reqPath = url.searchParams.get('path') || '';
        reqPath = reqPath.replace(/^\/+|\/+$/g, '');

        const repoId = HF_REPO_ID;
        const hfTreeUrl = reqPath 
          ? `https://huggingface.co/api/datasets/${repoId}/tree/main/${encodeURI(reqPath)}`
          : `https://huggingface.co/api/datasets/${repoId}/tree/main`;

        const hfHeaders = { 'User-Agent': 'HaruDrive/1.0' };
        if (HF_TOKEN) {
          hfHeaders['Authorization'] = `Bearer ${HF_TOKEN}`;
        }

        const hfRes = await fetch(hfTreeUrl, { headers: hfHeaders });
        if (!hfRes.ok) {
          const errText = await hfRes.text();
          return new Response(JSON.stringify({ error: `Hugging Face API error (${hfRes.status}): ${errText}` }), {
            status: hfRes.status,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const hfItems = await hfRes.json();
        const folderName = reqPath ? reqPath.split('/').pop() : 'Home';
        const formattedFiles = [];

        for (const item of hfItems) {
          const isDir = item.type === 'directory';
          const itemName = item.path.split('/').pop();
          
          if (itemName === '.gitattributes' || itemName === 'README.md' || itemName.startsWith('.git/')) {
            continue;
          }

          const shortId = await generateShortId(item.path);
          formattedFiles.push({
            id: shortId,
            path: item.path,
            name: itemName,
            mimeType: isDir ? 'application/vnd.google-apps.folder' : getMimeType(itemName),
            size: item.size || 0,
            modifiedTime: item.lastCommit ? item.lastCommit.date : new Date().toISOString()
          });
        }

        formattedFiles.sort((a, b) => {
          const aIsDir = a.mimeType === 'application/vnd.google-apps.folder';
          const bIsDir = b.mimeType === 'application/vnd.google-apps.folder';
          if (aIsDir && !bIsDir) return -1;
          if (!aIsDir && bIsDir) return 1;
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });

        if (env.harudrive_db && formattedFiles.length > 0) {
          try {
            const stmt = env.harudrive_db.prepare(
              'INSERT OR REPLACE INTO shortlinks (short_id, file_path, name, type, size) VALUES (?, ?, ?, ?, ?)'
            );
            const batch = formattedFiles.map(f =>
              stmt.bind(f.id, f.path, f.name, f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file', f.size)
            );
            for (let i = 0; i < batch.length; i += 100) {
              await env.harudrive_db.batch(batch.slice(i, i + 100));
            }
          } catch (e) {
            console.error('D1 Batch error:', e);
          }
        }

        return new Response(JSON.stringify({ folderName, currentPath: reqPath, files: formattedFiles }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // ==========================================
    // API: Admin Trigger Cloud Mirror (Protected by ADMIN_PIN)
    // ==========================================
    if (url.pathname === '/api/admin/mirror' && request.method === 'POST') {
      if (!isLoggedIn) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
      }

      try {
        const body = await request.json();
        const { gdrive_url, target_path, admin_pin } = body;

        // Verify Secret Admin PIN
        if (!admin_pin || admin_pin.trim() !== ADMIN_PIN.trim()) {
          return new Response(JSON.stringify({
            error: 'PIN Admin Salah! Akses mirror ditolak demi keamanan.'
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }

        if (!gdrive_url) {
          return new Response(JSON.stringify({ error: 'Google Drive URL is required.' }), { status: 400 });
        }

        const ghUrl = `https://api.github.com/repos/${GITHUB_REPO}/dispatches`;
        const ghRes = await fetch(ghUrl, {
          method: 'POST',
          headers: {
            'Authorization': `token ${GITHUB_PAT}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'HaruDrive-CloudflareWorker'
          },
          body: JSON.stringify({
            event_type: 'gdrive_mirror',
            client_payload: {
              gdrive_url,
              target_path: target_path || '',
              hf_repo: HF_REPO_ID
            }
          })
        });

        if (ghRes.status === 204 || ghRes.ok) {
          return new Response(JSON.stringify({
            success: true,
            message: '🚀 Cloud Mirror Job successfully dispatched to GitHub Actions! Transfer is running in the cloud.'
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } else {
          const errBody = await ghRes.text();
          return new Response(JSON.stringify({
            error: `GitHub API error (${ghRes.status}): ${errBody}`
          }), { status: ghRes.status, headers: { 'Content-Type': 'application/json' } });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // ==========================================
    // Handle File Download / Proxy / Streaming
    // ==========================================
    if (url.pathname.startsWith('/file/') || url.pathname.startsWith('/raw/')) {
      let rawPath = url.pathname.replace(/^\/(file|raw)\//, '');
      let pathParts = rawPath.split('/');
      let keyOrId = pathParts[0];
      let filePath = rawPath;
      let filename = url.searchParams.get('name');

      if (env.harudrive_db && keyOrId.length === 8) {
        try {
          const row = await env.harudrive_db.prepare(
            'SELECT file_path, name FROM shortlinks WHERE short_id = ?'
          ).bind(keyOrId).first();
          if (row && row.file_path) {
            filePath = row.file_path;
            if (!filename) filename = row.name;

            if (pathParts.length === 1 && filename) {
              return new Response(null, {
                status: 302,
                headers: {
                  'Location': `/file/${keyOrId}/${encodeURIComponent(filename)}`
                }
              });
            }
          }
        } catch (e) {}
      } else {
        if (pathParts.length > 1 && keyOrId.length === 8 && env.harudrive_db) {
          try {
            const row = await env.harudrive_db.prepare(
              'SELECT file_path FROM shortlinks WHERE short_id = ?'
            ).bind(keyOrId).first();
            if (row && row.file_path) filePath = row.file_path;
          } catch (e) {}
        }
      }

      const repoId = HF_REPO_ID;
      const hfFileUrl = `https://huggingface.co/datasets/${repoId}/resolve/main/${encodeURI(filePath)}`;

      const hfReqHeaders = new Headers();
      hfReqHeaders.set('User-Agent', 'HaruDrive/1.0');
      if (HF_TOKEN) {
        hfReqHeaders.set('Authorization', `Bearer ${HF_TOKEN}`);
      }

      const hasRange = request.headers.has('Range');
      if (hasRange) {
        hfReqHeaders.set('Range', request.headers.get('Range'));
      }

      const hfResponse = await fetch(hfFileUrl, {
        method: 'GET',
        headers: hfReqHeaders,
        redirect: 'follow'
      });

      const responseHeaders = new Headers(hfResponse.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Headers', 'Range, Authorization, Content-Type');
      responseHeaders.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
      responseHeaders.set('Accept-Ranges', 'bytes');

      if (filename) {
        const disposition = hasRange ? 'inline' : 'attachment';
        responseHeaders.set('Content-Disposition', `${disposition}; filename="${encodeURIComponent(filename)}"`);
      }

      return new Response(hfResponse.body, {
        status: hfResponse.status,
        statusText: hfResponse.statusText,
        headers: responseHeaders
      });
    }

    // Serve Main SPA UI
    return new Response(htmlPage(mainUI(), env), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
};

async function generateShortId(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  let hashBase64 = '';
  for (let i = 0; i < hashArray.length; i++) {
    hashBase64 += String.fromCharCode(hashArray[i]);
  }
  return btoa(hashBase64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').substring(0, 8);
}

function getMimeType(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const map = {
    'mp4': 'video/mp4', 'mkv': 'video/x-matroska', 'webm': 'video/webm', 'avi': 'video/x-msvideo', 'mov': 'video/quicktime',
    'mp3': 'audio/mpeg', 'flac': 'audio/flac', 'wav': 'audio/wav', 'ogg': 'audio/ogg', 'm4a': 'audio/mp4',
    'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp', 'svg': 'image/svg+xml',
    'pdf': 'application/pdf', 'zip': 'application/zip', 'rar': 'application/x-rar-compressed', '7z': 'application/x-7z-compressed',
    'tar': 'application/x-tar', 'gz': 'application/gzip', 'txt': 'text/plain', 'json': 'application/json'
  };
  return map[ext] || 'application/octet-stream';
}

function loginUI(errorMsg = '') {
  return `
  <div class="login-wrapper">
    <div class="login-card glass">
      <div class="brand-logo" style="justify-content:center; margin-bottom:12px;">
        <div class="logo-glow-wrap">
          <span class="logo-icon">🌸</span>
        </div>
        <div class="brand-info" style="text-align:left;">
          <h1 class="brand-title">HaruDrive</h1>
          <span class="brand-subtag">Cloud Index</span>
        </div>
      </div>
      <p class="brand-subtitle">High-Speed Cloud Storage Index powered by Hugging Face & Cloudflare</p>
      ${errorMsg ? `<div class="alert-error">${errorMsg}</div>` : ''}
      <form method="POST" action="/login" class="login-form">
        <div class="input-group">
          <input type="password" name="password" placeholder="Enter Access Password..." autofocus required />
        </div>
        <button type="submit" class="btn-primary">Unlock HaruDrive ✨</button>
      </form>
    </div>
  </div>`;
}

function mainUI() {
  return `
  <header class="navbar-cyber glass">
    <div class="nav-container">
      <div class="nav-left">
        <div class="brand-logo" onclick="triggerSakuraSecret()" style="cursor:pointer;" title="Click Sakura 3x for Admin Mode">
          <div class="logo-glow-wrap">
            <span class="logo-icon">🌸</span>
          </div>
          <div class="brand-info">
            <span class="brand-title">HaruDrive</span>
            <span class="brand-subtag">Cloud Index</span>
          </div>
        </div>
        <div class="status-capsule">
          <span class="pulse-dot"></span>
          <span class="status-text">HF 8TB Online</span>
        </div>
      </div>

      <div class="nav-center">
        <div class="spotlight-search glass">
          <span class="spotlight-icon">🔍</span>
          <input type="text" id="searchInput" placeholder="Search files & media globally..." oninput="onSearchInput(this)" />
          <span class="shortcut-badge">Ctrl K</span>
        </div>
      </div>

      <div class="nav-right">
        <button class="nav-btn glass" onclick="loadFiles(currentPath)" title="Reload Directory">
          <span class="btn-icon-symbol">🔄</span>
        </button>
        <button class="nav-btn glass btn-mirror-stealth" id="mirrorModalBtn" onclick="openMirrorModal()" title="Cloud Mirror (Admin Only)" style="display:none;">
          🚀 <span class="btn-text">Mirror</span>
        </button>
        <button class="nav-btn glass" id="darkToggle" onclick="toggleDark()" title="Toggle Dark / Light Mode">🌙</button>
        <a href="/logout" class="nav-btn glass logout-btn" title="Logout">🚪</a>
      </div>
    </div>

    <div class="filter-strip">
      <div class="filter-container">
        <button class="filter-chip active" data-filter="all" onclick="setCategoryFilter('all')">✨ Semua File</button>
        <button class="filter-chip" data-filter="video" onclick="setCategoryFilter('video')">🎬 Video & Film</button>
        <button class="filter-chip" data-filter="folder" onclick="setCategoryFilter('folder')">📁 Direktori</button>
        <button class="filter-chip" data-filter="archive" onclick="setCategoryFilter('archive')">📦 Archive (ZIP/RAR)</button>
        <button class="filter-chip" data-filter="doc" onclick="setCategoryFilter('doc')">📄 Dokumen</button>
      </div>
    </div>
  </header>

  <main class="container">
    <div class="breadcrumb-bar glass" id="breadcrumbBar">
      <span class="crumb-current">🏠 Home</span>
    </div>

    <div class="file-table-wrapper glass">
      <div class="table-header">
        <div class="col-cb"><input type="checkbox" id="selectAllCb" onchange="toggleSelectAll(this)" /></div>
        <div class="col-name">Name</div>
        <div class="col-size">Size</div>
        <div class="col-date">Modified</div>
        <div class="col-actions">Actions</div>
      </div>
      <div id="fileList" class="file-list">
        <div class="loading-state">
          <div class="spinner"></div>
          <p>Connecting to Hugging Face Storage...</p>
        </div>
      </div>
    </div>
  </main>

  <div id="bulkToolbar" class="bulk-toolbar glass" style="display:none;">
    <span id="bulkCount">0 selected</span>
    <div class="bulk-actions">
      <button class="btn-bulk primary" onclick="copySelectedLinks()">🔗 Copy Links</button>
      <button class="btn-bulk" onclick="downloadSelected()">⬇️ Download</button>
      <button class="btn-bulk text" onclick="deselectAll()">Cancel</button>
    </div>
  </div>

  <div id="videoModal" class="modal-backdrop" style="display:none;" onclick="if(event.target===this)closeModal()">
    <div class="modal-card video-card glass">
      <div class="modal-header">
        <div class="modal-title-group">
          <span class="modal-header-icon">🎬</span>
          <h3 id="modalTitle" class="modal-title">Streaming Video</h3>
        </div>
        <button class="btn-close-circle" onclick="closeModal()" title="Close">✕</button>
      </div>
      <div class="modal-body">
        <video id="videoPlayer" controls autoplay playsinline controlslist="nodownload"></video>
      </div>
      <div id="modalFooter" class="modal-footer"></div>
    </div>
  </div>

  <div id="mirrorModal" class="modal-backdrop" style="display:none;" onclick="if(event.target===this)closeMirrorModal()">
    <div class="modal-card mirror-card glass">
      <div class="modal-header">
        <div class="modal-title-group">
          <div class="modal-badge-icon">🚀</div>
          <div>
            <div class="title-with-badge">
              <h3 class="modal-title">Cloud-to-Cloud Mirror</h3>
              <span class="badge-admin">Admin Only 🛡️</span>
            </div>
            <p class="modal-subtitle">Transfer GDrive files straight to Hugging Face with 0% local bandwidth!</p>
          </div>
        </div>
        <button class="btn-close-circle" onclick="closeMirrorModal()" title="Close">✕</button>
      </div>

      <div class="modal-body">
        <div class="speed-info-banner">
          <div class="speed-badge">⚡ GIGABIT CLOUD SPEED</div>
          <p>Proses download dan upload berjalan 100% di server cloud runner. Laptop atau HP bisa dimatikan setelah proses dimulai.</p>
        </div>

        <form id="mirrorForm" onsubmit="submitCloudMirror(event)" class="mirror-form">
          <div class="form-field">
            <label for="mirrorGdriveUrl">
              <span>Google Drive File / Folder Link</span>
              <span class="label-hint">Public / Anyone with link</span>
            </label>
            <div class="input-with-icon">
              <span class="field-icon">🔗</span>
              <input type="text" id="mirrorGdriveUrl" placeholder="https://drive.google.com/drive/folders/... or File URL" required />
            </div>
          </div>

          <div class="form-field">
            <label for="mirrorTargetPath">
              <span>Target Folder in Hugging Face</span>
              <span class="label-hint">Optional</span>
            </label>
            <div class="input-with-icon">
              <span class="field-icon">📁</span>
              <input type="text" id="mirrorTargetPath" placeholder="e.g. Movies/2026 (leave blank for Root)" />
            </div>
          </div>

          <div class="admin-pin-card">
            <div class="pin-header">
              <label for="mirrorAdminPin">🔐 Admin Security PIN</label>
              <span class="pin-protected-tag">Protected</span>
            </div>
            <div class="input-with-icon">
              <span class="field-icon">🔑</span>
              <input type="password" id="mirrorAdminPin" placeholder="Enter 6-digit PIN..." required />
            </div>
            <label class="remember-pin-label">
              <input type="checkbox" id="rememberPinCb" />
              <span>Remember PIN on this device</span>
            </label>
          </div>

          <button type="submit" id="startMirrorBtn" class="btn-start-mirror">
            <span>⚡ Start Cloud Mirror (GitHub Actions)</span>
          </button>
        </form>

        <div class="or-divider">
          <span>ATAU JIKA LIMIT GITHUB HABIS</span>
        </div>

        <div class="colab-card-modern">
          <div class="colab-icon-badge">⚡</div>
          <div class="colab-info">
            <strong>Google Colab Runner (Unlimited Backup)</strong>
            <p>Jalankan script mirror di Google Colab dengan runtime 12 jam gratis & kecepatan gigabit.</p>
          </div>
          <a href="https://colab.research.google.com/github/IlhamRomadon297/haru-drive/blob/main/tools/HaruDrive_Colab_Mirror.ipynb" target="_blank" class="btn-colab-modern">
            Open Colab ↗
          </a>
        </div>
      </div>
    </div>
  </div>

  <div id="toastOverlay" class="toast-overlay" style="display:none;"></div>
  `;
}

const EMBEDDED_CLIENT_JS = "\nlet currentPath = '';\nlet allFiles = [];\nlet activeFilter = 'all';\nlet searchDebounceTimer = null;\nlet isSearching = false;\nlet sakuraClickCount = 0;\nlet sakuraClickTimer = null;\n\n// ==========================================\n// File Listing & Navigation\n// ==========================================\nasync function loadFiles(path) {\n  if (path === undefined || path === null) path = '';\n  currentPath = path;\n  isSearching = false;\n  const listEl = document.getElementById('fileList');\n  if (!listEl) return;\n  listEl.innerHTML = '<div class=\"loading-state\"><div class=\"spinner\"></div><p>Fetching files from Hugging Face Storage...</p></div>';\n  \n  updateBreadcrumbs(path);\n\n  try {\n    const res = await fetch('/api/list?path=' + encodeURIComponent(path));\n    if (!res.ok) {\n      const errData = await res.json().catch(() => ({}));\n      throw new Error(errData.error || 'Failed to fetch directory');\n    }\n    const data = await res.json();\n    allFiles = data.files || [];\n    applyFilterAndRender();\n  } catch (e) {\n    listEl.innerHTML = '<div class=\"loading-state\" style=\"color:#ef4444;\"><p>\u274c Error: ' + escapeHtml(e.message) + '</p></div>';\n  }\n}\n\nfunction setCategoryFilter(category) {\n  activeFilter = category;\n  document.querySelectorAll('.filter-chip').forEach(chip => {\n    if (chip.dataset.filter === category) {\n      chip.classList.add('active');\n    } else {\n      chip.classList.remove('active');\n    }\n  });\n  applyFilterAndRender();\n}\n\nfunction applyFilterAndRender() {\n  if (activeFilter === 'all') {\n    renderFiles(allFiles, isSearching);\n    return;\n  }\n  const filtered = allFiles.filter(file => {\n    const isDir = file.mimeType === 'application/vnd.google-apps.folder';\n    const isVideo = (file.mimeType && file.mimeType.startsWith('video/')) || /\\.(mp4|mkv|webm|avi|mov)$/i.test(file.name);\n    const isArchive = /\\.(zip|rar|7z|tar|gz)$/i.test(file.name);\n    const isDoc = /\\.(pdf|txt|docx?|xlsx?|pptx?|epub)$/i.test(file.name);\n\n    if (activeFilter === 'video') return isVideo;\n    if (activeFilter === 'folder') return isDir;\n    if (activeFilter === 'archive') return isArchive;\n    if (activeFilter === 'doc') return isDoc;\n    return true;\n  });\n  renderFiles(filtered, isSearching);\n}\n\nfunction renderFiles(files, isGlobalSearch = false) {\n  const listEl = document.getElementById('fileList');\n  if (!listEl) return;\n  if (!files || files.length === 0) {\n    listEl.innerHTML = '<div class=\"loading-state\"><p>' + (isGlobalSearch ? '\ud83d\udd0d No files matched your search' : '\ud83d\udcc2 Folder is empty') + '</p></div>';\n    return;\n  }\n\n  let html = '';\n  for (let i = 0; i < files.length; i++) {\n    const file = files[i];\n    const isDir = file.mimeType === 'application/vnd.google-apps.folder';\n    const isVideo = (file.mimeType && file.mimeType.startsWith('video/')) || /\\.(mp4|mkv|webm|avi|mov)$/i.test(file.name);\n    const isArchive = /\\.(zip|rar|7z|tar|gz)$/i.test(file.name);\n    const icon = isDir ? '\ud83d\udcc1' : (isVideo ? '\ud83c\udfac' : (isArchive ? '\ud83d\udce6' : '\ud83d\udcc4'));\n    const fileUrl = '/file/' + file.id + '/' + encodeURIComponent(file.name);\n\n    let actionBtns = '';\n    if (isVideo) {\n      actionBtns += '<button class=\"btn-act play\" data-name=\"' + encodeURIComponent(file.name) + '\" data-url=\"' + encodeURIComponent(fileUrl) + '\" onclick=\"handlePlayClick(this)\">\u25b6 Play</button>';\n    }\n    if (!isDir) {\n      actionBtns += '<a href=\"' + fileUrl + '\" class=\"btn-act\" download>\u2b07</a>';\n      actionBtns += '<button class=\"btn-act\" data-url=\"' + window.location.origin + fileUrl + '\" onclick=\"handleCopyClick(this)\">\ud83d\udd17</button>';\n    }\n\n    let clickAttr = '';\n    if (isDir) {\n      clickAttr = 'data-path=\"' + encodeURIComponent(file.path) + '\" onclick=\"handleFolderClick(this)\"';\n    } else if (isVideo) {\n      clickAttr = 'data-name=\"' + encodeURIComponent(file.name) + '\" data-url=\"' + encodeURIComponent(fileUrl) + '\" onclick=\"handlePlayClick(this)\"';\n    } else {\n      clickAttr = 'data-url=\"' + fileUrl + '\" onclick=\"handleFileClick(this)\"';\n    }\n\n    const folderBadge = (isGlobalSearch && file.parentDir) \n      ? '<span class=\"parent-badge\" data-path=\"' + encodeURIComponent(file.parentDir) + '\" onclick=\"event.stopPropagation(); handleFolderClick(this)\">\ud83d\udcc1 ' + escapeHtml(file.parentDir) + '</span>' \n      : '';\n\n    html += '<div class=\"file-row ' + (isDir ? 'is-folder' : '') + '\">' +\n      '<div class=\"col-cb\">' +\n        (!isDir ? '<input type=\"checkbox\" class=\"item-cb\" value=\"' + window.location.origin + fileUrl + '\" onchange=\"updateBulkToolbar()\" />' : '') +\n      '</div>' +\n      '<div class=\"file-name-cell\" ' + clickAttr + '>' +\n        '<span class=\"file-icon\">' + icon + '</span>' +\n        '<div class=\"file-info-group\">' +\n          '<span class=\"file-title\">' + escapeHtml(file.name) + '</span>' +\n          folderBadge +\n        '</div>' +\n      '</div>' +\n      '<div class=\"file-size-cell\">' + (isDir ? '-' : formatBytes(file.size)) + '</div>' +\n      '<div class=\"file-date-cell\">' + formatDate(file.modifiedTime) + '</div>' +\n      '<div class=\"file-actions-cell\">' + actionBtns + '</div>' +\n    '</div>';\n  }\n  listEl.innerHTML = html;\n}\n\nfunction handleFolderClick(el) {\n  const path = decodeURIComponent(el.dataset.path || '');\n  const searchInput = document.getElementById('searchInput');\n  if (searchInput) searchInput.value = '';\n  navigateTo(path);\n}\n\nfunction handlePlayClick(el) {\n  const name = decodeURIComponent(el.dataset.name || '');\n  const url = decodeURIComponent(el.dataset.url || '');\n  openVideoModal(name, url);\n}\n\nfunction handleFileClick(el) {\n  const url = el.dataset.url || '';\n  if (url) window.open(url, '_blank');\n}\n\nfunction handleCopyClick(el) {\n  const url = el.dataset.url || '';\n  copyLink(url);\n}\n\nfunction navigateTo(path) {\n  window.history.pushState(null, '', path ? '?p=' + encodeURIComponent(path) : '/');\n  loadFiles(path);\n}\n\nfunction updateBreadcrumbs(path) {\n  const bar = document.getElementById('breadcrumbBar');\n  if (!bar) return;\n  if (!path) {\n    bar.innerHTML = '<span class=\"crumb-current\">\ud83c\udfe0 Home</span>';\n    return;\n  }\n  const parts = path.split('/');\n  let html = '<span class=\"crumb\" onclick=\"navigateTo(\\'\\')\">\ud83c\udfe0 Home</span>';\n  let accum = '';\n  for (let idx = 0; idx < parts.length; idx++) {\n    const p = parts[idx];\n    accum += (idx === 0 ? '' : '/') + p;\n    const isLast = idx === parts.length - 1;\n    html += ' <span class=\"crumb-sep\">\u203a</span> ';\n    if (isLast) {\n      html += '<span class=\"crumb-current\">' + escapeHtml(p) + '</span>';\n    } else {\n      html += '<span class=\"crumb\" data-target=\"' + encodeURIComponent(accum) + '\" onclick=\"navigateTo(decodeURIComponent(this.dataset.target))\">' + escapeHtml(p) + '</span>';\n    }\n  }\n  bar.innerHTML = html;\n}\n\n// ==========================================\n// Realtime Global Search (D1 Database)\n// ==========================================\nfunction onSearchInput(input) {\n  const q = input.value.trim();\n  clearTimeout(searchDebounceTimer);\n  \n  if (!q) {\n    if (isSearching) {\n      isSearching = false;\n      updateBreadcrumbs(currentPath);\n      applyFilterAndRender();\n    }\n    return;\n  }\n\n  searchDebounceTimer = setTimeout(async () => {\n    isSearching = true;\n    const listEl = document.getElementById('fileList');\n    if (listEl) {\n      listEl.innerHTML = '<div class=\"loading-state\"><div class=\"spinner\"></div><p>Searching globally across all folders...</p></div>';\n    }\n    \n    const bar = document.getElementById('breadcrumbBar');\n    if (bar) {\n      bar.innerHTML = '<span class=\"crumb-current\">\ud83d\udd0d Global Search: \"' + escapeHtml(q) + '\"</span> <button class=\"btn-clear-search\" onclick=\"clearSearch()\">\u2715 Clear</button>';\n    }\n\n    try {\n      const res = await fetch('/api/search?q=' + encodeURIComponent(q));\n      if (!res.ok) throw new Error('Search failed');\n      const data = await res.json();\n      allFiles = data.files || [];\n      applyFilterAndRender();\n    } catch (e) {\n      if (listEl) {\n        listEl.innerHTML = '<div class=\"loading-state\" style=\"color:#ef4444;\"><p>\u274c Search error: ' + escapeHtml(e.message) + '</p></div>';\n      }\n    }\n  }, 250);\n}\n\nfunction clearSearch() {\n  const input = document.getElementById('searchInput');\n  if (input) input.value = '';\n  isSearching = false;\n  loadFiles(currentPath);\n}\n\n// Keyboard shortcuts (Ctrl + K to search)\nwindow.addEventListener('keydown', (e) => {\n  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {\n    e.preventDefault();\n    const input = document.getElementById('searchInput');\n    if (input) {\n      input.focus();\n      input.select();\n    }\n  }\n  if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {\n    e.preventDefault();\n    revealAdminMirror();\n  }\n});\n\n// ==========================================\n// Bulk Actions Toolbar\n// ==========================================\nfunction updateBulkToolbar() {\n  const checked = document.querySelectorAll('.item-cb:checked');\n  const bar = document.getElementById('bulkToolbar');\n  if (!bar) return;\n  if (checked.length > 0) {\n    bar.style.display = 'flex';\n    const countEl = document.getElementById('bulkCount');\n    if (countEl) countEl.textContent = checked.length + ' selected';\n  } else {\n    bar.style.display = 'none';\n  }\n}\n\nfunction toggleSelectAll(masterCb) {\n  document.querySelectorAll('.item-cb').forEach(cb => { cb.checked = masterCb.checked; });\n  updateBulkToolbar();\n}\n\nfunction deselectAll() {\n  document.querySelectorAll('.item-cb').forEach(cb => { cb.checked = false; });\n  const master = document.getElementById('selectAllCb');\n  if (master) master.checked = false;\n  updateBulkToolbar();\n}\n\nfunction copySelectedLinks() {\n  const selected = Array.from(document.querySelectorAll('.item-cb:checked')).map(cb => cb.value);\n  if (!selected.length) return;\n  navigator.clipboard.writeText(selected.join('\\n')).then(() => {\n    showToast('Copied ' + selected.length + ' links to clipboard! \ud83d\udccb');\n    deselectAll();\n  });\n}\n\nfunction copyLink(url) {\n  navigator.clipboard.writeText(url).then(() => { showToast('Link copied to clipboard! \ud83d\udd17'); });\n}\n\nasync function downloadSelected() {\n  const selected = Array.from(document.querySelectorAll('.item-cb:checked')).map(cb => cb.value);\n  if (!selected.length) return;\n  showToast('Starting batch download...');\n  for (let i = 0; i < selected.length; i++) {\n    const a = document.createElement('a');\n    a.href = selected[i];\n    a.download = '';\n    document.body.appendChild(a);\n    a.click();\n    document.body.removeChild(a);\n    await new Promise(r => setTimeout(r, 600));\n  }\n  deselectAll();\n}\n\n// ==========================================\n// Video Player Modal\n// ==========================================\nfunction openVideoModal(name, url) {\n  const titleEl = document.getElementById('modalTitle');\n  if (titleEl) titleEl.textContent = name;\n  const player = document.getElementById('videoPlayer');\n  if (player) {\n    player.src = url;\n    player.play().catch(() => {});\n  }\n  \n  const fullUrl = window.location.origin + url;\n  const cleanUrl = fullUrl.replace(/^https?:\\/\\//, '');\n  const footer = document.getElementById('modalFooter');\n  if (footer) {\n    footer.innerHTML = \n      '<a href=\"' + url + '\" class=\"btn-player primary\" download>\u2b07 Download Video</a>' +\n      '<button class=\"btn-player\" data-url=\"' + fullUrl + '\" onclick=\"handleCopyClick(this)\">\ud83d\udd17 Copy Stream Link</button>' +\n      '<a href=\"potplayer://' + fullUrl + '\" class=\"btn-player\">PotPlayer</a>' +\n      '<a href=\"vlc://' + fullUrl + '\" class=\"btn-player\">VLC iOS/Mac</a>' +\n      '<a href=\"iina://weblink?url=' + fullUrl + '\" class=\"btn-player\">IINA (Mac)</a>' +\n      '<a href=\"intent://' + cleanUrl + '#Intent;action=android.intent.action.VIEW;scheme=https;type=video/*;package=org.videolan.vlc;end\" class=\"btn-player\">VLC Android</a>' +\n      '<a href=\"intent://' + cleanUrl + '#Intent;action=android.intent.action.VIEW;scheme=https;type=video/*;package=com.mxtech.videoplayer.ad;end\" class=\"btn-player\">MX Player</a>';\n  }\n\n  const modal = document.getElementById('videoModal');\n  if (modal) modal.style.display = 'flex';\n}\n\nfunction closeModal() {\n  const modal = document.getElementById('videoModal');\n  if (modal) modal.style.display = 'none';\n  const player = document.getElementById('videoPlayer');\n  if (player) {\n    player.pause();\n    player.src = '';\n  }\n}\n\n// ==========================================\n// Stealth Mode & Admin Mirror Modal (PIN 290722 Protected)\n// ==========================================\nfunction triggerSakuraSecret() {\n  sakuraClickCount++;\n  clearTimeout(sakuraClickTimer);\n  sakuraClickTimer = setTimeout(() => { sakuraClickCount = 0; }, 2000);\n\n  if (sakuraClickCount >= 3) {\n    sakuraClickCount = 0;\n    revealAdminMirror();\n  }\n}\n\nfunction revealAdminMirror() {\n  const btn = document.getElementById('mirrorModalBtn');\n  if (btn) {\n    btn.style.display = 'inline-flex';\n  }\n  showToast('\u2728 Admin Mode Activated!');\n  openMirrorModal();\n}\n\nfunction openMirrorModal() {\n  const pinInput = document.getElementById('mirrorAdminPin');\n  const savedPin = localStorage.getItem('harudrive_admin_pin');\n  if (pinInput && savedPin) {\n    pinInput.value = savedPin;\n    const rememberCb = document.getElementById('rememberPinCb');\n    if (rememberCb) rememberCb.checked = true;\n  }\n  const m = document.getElementById('mirrorModal');\n  if (m) m.style.display = 'flex';\n}\n\nfunction closeMirrorModal() {\n  const m = document.getElementById('mirrorModal');\n  if (m) m.style.display = 'none';\n}\n\nasync function submitCloudMirror(e) {\n  e.preventDefault();\n  const gdriveInput = document.getElementById('mirrorGdriveUrl');\n  const targetInput = document.getElementById('mirrorTargetPath');\n  const pinInput = document.getElementById('mirrorAdminPin');\n  const rememberCb = document.getElementById('rememberPinCb');\n\n  const gdrive_url = gdriveInput ? gdriveInput.value.trim() : '';\n  const target_path = targetInput ? targetInput.value.trim() : '';\n  const admin_pin = pinInput ? pinInput.value.trim() : '';\n\n  if (!admin_pin) {\n    alert('\u26a0\ufe0f Harap masukkan Admin PIN untuk memulai mirror.');\n    if (pinInput) pinInput.focus();\n    return;\n  }\n\n  const btn = document.getElementById('startMirrorBtn');\n  if (btn) {\n    btn.disabled = true;\n    btn.textContent = '\ud83d\ude80 Verifying PIN & Dispatching...';\n  }\n\n  try {\n    const res = await fetch('/api/admin/mirror', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ gdrive_url: gdrive_url, target_path: target_path, admin_pin: admin_pin })\n    });\n    const result = await res.json();\n    if (res.ok && result.success) {\n      if (rememberCb && rememberCb.checked) {\n        localStorage.setItem('harudrive_admin_pin', admin_pin);\n      } else {\n        localStorage.removeItem('harudrive_admin_pin');\n      }\n      alert('\u2705 SUCCESS!\\n\\n' + result.message + '\\n\\nProses mirror sedang berjalan di GitHub Actions Cloud.');\n      closeMirrorModal();\n    } else {\n      alert('\u274c Akses Ditolak: ' + (result.error || 'PIN Admin Salah atau gagal dispatch job.'));\n      if (pinInput) {\n        pinInput.focus();\n        pinInput.select();\n      }\n    }\n  } catch (err) {\n    alert('\u274c Error: ' + err.message);\n  } finally {\n    if (btn) {\n      btn.disabled = false;\n      btn.textContent = '\u26a1 Start Cloud Mirror (GitHub Actions)';\n    }\n  }\n}\n\n// ==========================================\n// Utilities & Init\n// ==========================================\nfunction showToast(msg) {\n  const toast = document.getElementById('toastOverlay');\n  if (!toast) return;\n  toast.textContent = msg;\n  toast.style.display = 'block';\n  setTimeout(() => { toast.style.display = 'none'; }, 3000);\n}\n\nfunction toggleDark() {\n  const isLight = document.body.classList.toggle('light');\n  localStorage.setItem('haruTheme', isLight ? 'light' : 'dark');\n  const toggle = document.getElementById('darkToggle');\n  if (toggle) toggle.textContent = isLight ? '\ud83c\udf19' : '\u2600\ufe0f';\n}\n\nfunction formatBytes(bytes) {\n  if (!bytes || bytes === 0) return '0 B';\n  const k = 1024;\n  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];\n  const i = Math.floor(Math.log(bytes) / Math.log(k));\n  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];\n}\n\nfunction formatDate(dateStr) {\n  if (!dateStr) return '-';\n  const d = new Date(dateStr);\n  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });\n}\n\nfunction escapeHtml(str) {\n  return (str || '').replace(/[&<>\"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[m]));\n}\n\n// History back/forward navigation\nwindow.addEventListener('popstate', () => {\n  const params = new URLSearchParams(window.location.search);\n  loadFiles(params.get('p') || '');\n});\n\n// Initialization\nfunction initHaruDrive() {\n  if (localStorage.getItem('haruTheme') === 'light') {\n    document.body.classList.add('light');\n    const toggle = document.getElementById('darkToggle');\n    if (toggle) toggle.textContent = '\ud83c\udf19';\n  }\n  if (localStorage.getItem('harudrive_admin_pin')) {\n    const btn = document.getElementById('mirrorModalBtn');\n    if (btn) btn.style.display = 'inline-flex';\n  }\n  const params = new URLSearchParams(window.location.search);\n  loadFiles(params.get('p') || '');\n}\n\nif (document.readyState === 'loading') {\n  document.addEventListener('DOMContentLoaded', initHaruDrive);\n} else {\n  initHaruDrive();\n}\n";

function htmlPage(content, env) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HaruDrive - High-Speed Cloud Storage Index</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🌸</text></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #6366f1;
      --primary-light: #818cf8;
      --accent: #ec4899;
      --accent-gradient: linear-gradient(135deg, #ec4899 0%, #a855f7 50%, #6366f1 100%);
      --bg: #090d16;
      --bg-surface: rgba(17, 24, 39, 0.75);
      --bg-card: rgba(22, 30, 49, 0.85);
      --border: rgba(255, 255, 255, 0.08);
      --border-focus: rgba(236, 72, 153, 0.5);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --hover-row: rgba(99, 102, 241, 0.08);
      --radius: 16px;
      --radius-sm: 10px;
      --font: 'Plus Jakarta Sans', -apple-system, sans-serif;
    }

    body.light {
      --bg: #f8fafc;
      --bg-surface: rgba(255, 255, 255, 0.85);
      --bg-card: rgba(255, 255, 255, 0.95);
      --border: rgba(0, 0, 0, 0.08);
      --border-focus: rgba(236, 72, 153, 0.5);
      --text: #0f172a;
      --text-muted: #64748b;
      --text-dim: #94a3b8;
      --hover-row: rgba(99, 102, 241, 0.05);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font);
      background-color: var(--bg);
      background-image: radial-gradient(at 0% 0%, rgba(236, 72, 153, 0.15) 0px, transparent 45%),
                        radial-gradient(at 100% 0%, rgba(99, 102, 241, 0.15) 0px, transparent 45%),
                        radial-gradient(at 50% 100%, rgba(168, 85, 247, 0.1) 0px, transparent 50%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      transition: background 0.3s, color 0.3s;
    }

    .glass {
      background: var(--bg-surface);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border);
    }

    /* ==========================================
       CYBER-SAKURA NAVBAR & HEADER
       ========================================== */
    .navbar-cyber {
      position: sticky;
      top: 0;
      z-index: 100;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
    }
    .nav-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 28px;
      gap: 20px;
    }
    .nav-left, .nav-right {
      display: flex;
      align-items: center;
      gap: 14px;
      flex-shrink: 0;
    }
    .nav-center {
      flex: 1;
      max-width: 520px;
      display: flex;
      justify-content: center;
    }

    .brand-logo {
      display: flex;
      align-items: center;
      gap: 12px;
      user-select: none;
    }
    .logo-glow-wrap {
      width: 40px;
      height: 40px;
      border-radius: 12px;
      background: rgba(236, 72, 153, 0.15);
      border: 1px solid rgba(236, 72, 153, 0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 20px rgba(236, 72, 153, 0.25);
      transition: transform 0.25s, box-shadow 0.25s;
    }
    .brand-logo:hover .logo-glow-wrap {
      transform: scale(1.1) rotate(12deg);
      box-shadow: 0 0 25px rgba(236, 72, 153, 0.45);
    }
    .logo-icon { font-size: 1.45rem; }
    .brand-info { display: flex; flex-direction: column; }
    .brand-title {
      font-size: 1.3rem;
      font-weight: 800;
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
      line-height: 1.2;
    }
    .brand-subtag {
      font-size: 0.68rem;
      font-weight: 600;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .status-capsule {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 20px;
      background: rgba(16, 185, 129, 0.1);
      border: 1px solid rgba(16, 185, 129, 0.25);
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
      100% { opacity: 1; transform: scale(1); }
    }
    .status-text {
      font-size: 0.72rem;
      font-weight: 700;
      color: #34d399;
      letter-spacing: 0.2px;
    }

    .spotlight-search {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      border-radius: 24px;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(255, 255, 255, 0.1);
      transition: all 0.25s;
    }
    .spotlight-search:focus-within {
      border-color: var(--accent);
      background: rgba(15, 23, 42, 0.9);
      box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.2), 0 10px 25px rgba(0,0,0,0.3);
    }
    .spotlight-icon { font-size: 0.95rem; color: var(--text-dim); }
    .spotlight-search input {
      background: transparent;
      border: none;
      outline: none;
      color: var(--text);
      font-family: inherit;
      font-size: 0.88rem;
      width: 100%;
    }
    .shortcut-badge {
      font-size: 0.65rem;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--text-dim);
      white-space: nowrap;
      user-select: none;
    }

    .nav-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 20px;
      color: var(--text);
      text-decoration: none;
      font-size: 0.86rem;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--bg-card);
      transition: all 0.2s;
    }
    .nav-btn:hover {
      border-color: var(--primary-light);
      background: rgba(99, 102, 241, 0.15);
      transform: translateY(-1px);
    }
    .btn-icon-symbol { font-size: 0.9rem; transition: transform 0.3s; }
    .nav-btn:hover .btn-icon-symbol { transform: rotate(180deg); }
    .btn-mirror-stealth {
      background: rgba(236, 72, 153, 0.12);
      border-color: rgba(236, 72, 153, 0.35);
      color: #f43f5e;
    }

    .filter-strip {
      padding: 8px 28px;
      background: rgba(11, 15, 25, 0.4);
      border-top: 1px solid rgba(255, 255, 255, 0.04);
      overflow-x: auto;
    }
    .filter-container {
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: 1200px;
      margin: 0 auto;
    }
    .filter-chip {
      padding: 5px 12px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-muted);
      font-size: 0.78rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s;
    }
    .filter-chip:hover {
      color: var(--text);
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .filter-chip.active {
      background: var(--accent-gradient);
      color: #fff;
      border-color: transparent;
      box-shadow: 0 2px 10px rgba(236, 72, 153, 0.3);
    }

    .container {
      max-width: 1200px;
      width: 100%;
      margin: 20px auto;
      padding: 0 20px;
      flex: 1;
    }

    .breadcrumb-bar {
      padding: 10px 18px;
      border-radius: var(--radius);
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.88rem;
      font-weight: 600;
      flex-wrap: wrap;
    }
    .crumb {
      color: var(--primary-light);
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .crumb:hover { opacity: 0.8; text-decoration: underline; }
    .crumb-sep { color: var(--text-dim); }
    .crumb-current { color: var(--text); font-weight: 700; }
    .btn-clear-search {
      margin-left: auto;
      padding: 4px 10px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-muted);
      font-size: 0.75rem;
      font-weight: 700;
      cursor: pointer;
    }
    .btn-clear-search:hover { color: var(--text); background: var(--hover-row); }

    .file-table-wrapper {
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
    }
    .table-header {
      display: flex;
      align-items: center;
      padding: 14px 18px;
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      border-bottom: 1px solid var(--border);
      user-select: none;
    }
    .col-cb { width: 36px; display: flex; align-items: center; }
    .col-name { flex: 1; }
    .col-size { width: 120px; text-align: right; }
    .col-date { width: 150px; text-align: right; }
    .col-actions { width: 180px; text-align: right; }

    .file-row {
      display: flex;
      align-items: center;
      padding: 12px 18px;
      border-bottom: 1px solid var(--border);
      transition: background 0.15s;
    }
    .file-row:hover { background: var(--hover-row); }
    .file-row:last-child { border-bottom: none; }

    .file-name-cell {
      display: flex;
      align-items: center;
      gap: 12px;
      flex: 1;
      cursor: pointer;
      min-width: 0;
    }
    .file-icon { font-size: 1.25rem; flex-shrink: 0; }
    .file-info-group {
      display: flex;
      flex-direction: column;
      min-width: 0;
      gap: 2px;
    }
    .file-title {
      font-size: 0.92rem;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-row.is-folder .file-title { color: var(--primary-light); }
    .parent-badge {
      font-size: 0.72rem;
      color: var(--text-dim);
      background: rgba(255,255,255,0.05);
      padding: 2px 6px;
      border-radius: 4px;
      align-self: flex-start;
    }
    .parent-badge:hover { color: var(--primary-light); text-decoration: underline; }

    .file-size-cell, .file-date-cell {
      font-size: 0.82rem;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
    }
    .file-size-cell { width: 120px; text-align: right; }
    .file-date-cell { width: 150px; text-align: right; }

    .file-actions-cell {
      width: 180px;
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .btn-act {
      padding: 6px 10px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text);
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s;
    }
    .btn-act:hover {
      border-color: var(--primary-light);
      background: var(--primary);
      color: white;
    }
    .btn-act.play {
      background: rgba(236, 72, 153, 0.15);
      border-color: rgba(236, 72, 153, 0.3);
      color: #f43f5e;
    }
    .btn-act.play:hover {
      background: #ec4899;
      color: white;
    }

    .bulk-toolbar {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 10px 20px;
      border-radius: 30px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.4);
      z-index: 90;
    }
    .btn-bulk {
      padding: 6px 14px;
      border-radius: 20px;
      border: none;
      font-weight: 600;
      font-size: 0.85rem;
      cursor: pointer;
      background: var(--bg-card);
      color: var(--text);
    }
    .btn-bulk.primary { background: var(--primary); color: white; }

    /* ==========================================
       MODAL SYSTEM
       ========================================== */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(5, 8, 16, 0.82);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      z-index: 2000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      overflow-y: auto;
    }
    .modal-card {
      width: 100%;
      max-width: 600px;
      max-height: calc(100vh - 48px);
      display: flex;
      flex-direction: column;
      border-radius: 20px;
      background: linear-gradient(180deg, rgba(26, 34, 52, 0.95) 0%, rgba(17, 24, 39, 0.98) 100%);
      border: 1px solid rgba(255, 255, 255, 0.12);
      box-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.8), 0 0 40px rgba(236, 72, 153, 0.12);
      overflow: hidden;
      animation: modalPop 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes modalPop {
      0% { opacity: 0; transform: scale(0.94) translateY(10px); }
      100% { opacity: 1; transform: scale(1) translateY(0); }
    }
    .video-card { max-width: 860px; }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.02);
    }
    .modal-title-group { display: flex; align-items: center; gap: 14px; }
    .modal-badge-icon {
      width: 44px;
      height: 44px;
      border-radius: 14px;
      background: rgba(236, 72, 153, 0.15);
      border: 1px solid rgba(236, 72, 153, 0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.4rem;
      flex-shrink: 0;
    }
    .modal-header-icon { font-size: 1.5rem; }
    .title-with-badge { display: flex; align-items: center; gap: 10px; }
    .modal-title {
      font-size: 1.18rem;
      font-weight: 800;
      color: #fff;
      letter-spacing: -0.3px;
    }
    .badge-admin {
      font-size: 0.7rem;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 12px;
      background: rgba(236, 72, 153, 0.2);
      border: 1px solid rgba(236, 72, 153, 0.4);
      color: #f43f5e;
    }
    .modal-subtitle {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .btn-close-circle {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-muted);
      font-size: 0.95rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .btn-close-circle:hover {
      background: rgba(239, 68, 68, 0.2);
      border-color: rgba(239, 68, 68, 0.4);
      color: #ef4444;
      transform: rotate(90deg);
    }

    .modal-body {
      padding: 24px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    .modal-body::-webkit-scrollbar { width: 6px; }
    .modal-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 6px; }

    .speed-info-banner {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.12) 0%, rgba(236, 72, 153, 0.08) 100%);
      border: 1px solid rgba(99, 102, 241, 0.25);
      padding: 14px 16px;
      border-radius: 12px;
    }
    .speed-badge {
      display: inline-block;
      font-size: 0.7rem;
      font-weight: 800;
      padding: 3px 8px;
      background: var(--primary);
      color: #fff;
      border-radius: 6px;
      margin-bottom: 6px;
      letter-spacing: 0.4px;
    }
    .speed-info-banner p {
      font-size: 0.82rem;
      color: var(--text-muted);
      line-height: 1.45;
    }

    .mirror-form {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .form-field {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .form-field label {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.84rem;
      font-weight: 600;
      color: #cbd5e1;
    }
    .label-hint {
      font-size: 0.74rem;
      font-weight: 500;
      color: var(--text-dim);
    }
    .input-with-icon {
      position: relative;
      display: flex;
      align-items: center;
    }
    .field-icon {
      position: absolute;
      left: 14px;
      font-size: 1rem;
      color: var(--text-dim);
      pointer-events: none;
    }
    .input-with-icon input {
      width: 100%;
      padding: 12px 14px 12px 42px;
      border-radius: 12px;
      background: rgba(15, 23, 42, 0.65);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #f8fafc;
      font-family: inherit;
      font-size: 0.92rem;
      outline: none;
      transition: all 0.2s;
    }
    .input-with-icon input:focus {
      border-color: var(--accent);
      background: rgba(15, 23, 42, 0.9);
      box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.2);
    }

    .admin-pin-card {
      background: rgba(236, 72, 153, 0.06);
      border: 1px solid rgba(236, 72, 153, 0.2);
      padding: 16px;
      border-radius: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .pin-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .pin-header label {
      font-size: 0.86rem;
      font-weight: 700;
      color: #f43f5e;
    }
    .pin-protected-tag {
      font-size: 0.7rem;
      font-weight: 700;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .remember-pin-label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 0.82rem;
      color: var(--text-muted);
      cursor: pointer;
      user-select: none;
      margin-top: 2px;
    }
    .remember-pin-label input[type="checkbox"] {
      accent-color: var(--accent);
      width: 15px;
      height: 15px;
      cursor: pointer;
    }

    .btn-start-mirror {
      width: 100%;
      padding: 14px;
      border-radius: 12px;
      border: none;
      background: var(--accent-gradient);
      color: #fff;
      font-weight: 800;
      font-size: 0.98rem;
      letter-spacing: 0.2px;
      cursor: pointer;
      box-shadow: 0 8px 24px rgba(236, 72, 153, 0.35);
      transition: all 0.2s;
    }
    .btn-start-mirror:hover {
      transform: translateY(-1px);
      box-shadow: 0 10px 28px rgba(236, 72, 153, 0.45);
      opacity: 0.95;
    }
    .btn-start-mirror:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }

    .or-divider {
      text-align: center;
      position: relative;
      margin: 4px 0;
    }
    .or-divider::before {
      content: '';
      position: absolute;
      left: 0; top: 50%;
      width: 100%; height: 1px;
      background: rgba(255, 255, 255, 0.08);
    }
    .or-divider span {
      position: relative;
      background: #111827;
      padding: 0 12px;
      font-size: 0.7rem;
      font-weight: 700;
      color: var(--text-dim);
      letter-spacing: 0.5px;
    }

    .colab-card-modern {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 18px;
      border-radius: 14px;
      border: 1px solid rgba(245, 158, 11, 0.25);
      background: rgba(245, 158, 11, 0.05);
    }
    .colab-icon-badge {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.3);
      color: #f59e0b;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.1rem;
      flex-shrink: 0;
    }
    .colab-info { flex: 1; min-width: 0; }
    .colab-info strong { font-size: 0.88rem; color: #fbbf24; display: block; }
    .colab-info p { font-size: 0.76rem; color: var(--text-muted); margin-top: 2px; line-height: 1.35; }
    .btn-colab-modern {
      padding: 8px 14px;
      border-radius: 10px;
      background: #f59e0b;
      color: #000;
      font-weight: 700;
      font-size: 0.82rem;
      text-decoration: none;
      white-space: nowrap;
      transition: all 0.2s;
    }
    .btn-colab-modern:hover { background: #fbbf24; transform: translateY(-1px); }

    #videoPlayer {
      width: 100%;
      border-radius: var(--radius-sm);
      max-height: 480px;
      background: black;
    }
    .modal-footer {
      padding: 16px 24px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(255, 255, 255, 0.02);
    }
    .btn-player {
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text);
      text-decoration: none;
      font-size: 0.82rem;
      font-weight: 600;
      transition: all 0.2s;
      cursor: pointer;
    }
    .btn-player:hover {
      border-color: var(--primary-light);
      background: var(--primary);
      color: white;
    }
    .btn-player.primary {
      background: var(--accent-gradient);
      color: white;
      border: none;
    }

    .login-wrapper {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .login-card {
      width: 100%;
      max-width: 420px;
      padding: 36px 32px;
      border-radius: var(--radius);
      text-align: center;
    }
    .brand-subtitle { font-size: 0.85rem; color: var(--text-muted); margin: 8px 0 24px 0; }
    .alert-error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #ef4444;
      padding: 8px 12px;
      border-radius: var(--radius-sm);
      font-size: 0.82rem;
      margin-bottom: 16px;
    }
    .input-group input {
      width: 100%;
      padding: 12px 16px;
      border-radius: var(--radius-sm);
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 0.95rem;
      outline: none;
      margin-bottom: 16px;
    }

    .toast-overlay {
      position: fixed;
      bottom: 30px; right: 30px;
      padding: 12px 20px;
      border-radius: var(--radius-sm);
      background: var(--primary);
      color: white;
      font-weight: 600;
      font-size: 0.9rem;
      box-shadow: 0 10px 25px rgba(0,0,0,0.3);
      z-index: 3000;
      animation: modalPop 0.2s ease-out;
    }

    .spinner {
      width: 32px; height: 32px;
      border: 3px solid rgba(99, 102, 241, 0.2);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 20px auto 10px auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-state { text-align: center; padding: 40px 0; color: var(--text-muted); }
  </style>
</head>
<body>
  ${content}
  <script>${EMBEDDED_CLIENT_JS}</script>
</body>
</html>`;
}
