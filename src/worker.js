export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Authentication Check
    const cookie = request.headers.get('Cookie') || '';
    const isLoggedIn = cookie.includes('harudrive_auth=true');

    // Handle Login Submit
    if (url.pathname === '/login' && request.method === 'POST') {
      const formData = await request.formData();
      const password = formData.get('password');
      if (password === env.APP_PASSWORD) {
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

        const repoId = env.HF_REPO_ID;
        if (!repoId) {
          return new Response(JSON.stringify({ error: 'HF_REPO_ID is not configured in Worker environment.' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const hfTreeUrl = reqPath 
          ? `https://huggingface.co/api/datasets/${repoId}/tree/main/${encodeURI(reqPath)}`
          : `https://huggingface.co/api/datasets/${repoId}/tree/main`;

        const hfHeaders = { 'User-Agent': 'HaruDrive/1.0' };
        if (env.HF_TOKEN) {
          hfHeaders['Authorization'] = `Bearer ${env.HF_TOKEN}`;
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
        const expectedPin = env.ADMIN_PIN || '290722';
        if (!admin_pin || admin_pin.trim() !== expectedPin.trim()) {
          return new Response(JSON.stringify({
            error: 'PIN Admin Salah! Akses mirror ditolak demi keamanan.'
          }), { status: 403, headers: { 'Content-Type': 'application/json' } });
        }

        if (!gdrive_url) {
          return new Response(JSON.stringify({ error: 'Google Drive URL is required.' }), { status: 400 });
        }

        if (!env.GITHUB_PAT || !env.GITHUB_REPO) {
          return new Response(JSON.stringify({
            error: 'GITHUB_PAT or GITHUB_REPO is not configured in Worker secrets.'
          }), { status: 500 });
        }

        const ghUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`;
        const ghRes = await fetch(ghUrl, {
          method: 'POST',
          headers: {
            'Authorization': `token ${env.GITHUB_PAT}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'HaruDrive-CloudflareWorker'
          },
          body: JSON.stringify({
            event_type: 'gdrive_mirror',
            client_payload: {
              gdrive_url,
              target_path: target_path || '',
              hf_repo: env.HF_REPO_ID
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

      const repoId = env.HF_REPO_ID;
      const hfFileUrl = `https://huggingface.co/datasets/${repoId}/resolve/main/${encodeURI(filePath)}`;

      const hfReqHeaders = new Headers();
      hfReqHeaders.set('User-Agent', 'HaruDrive/1.0');
      if (env.HF_TOKEN) {
        hfReqHeaders.set('Authorization', `Bearer ${env.HF_TOKEN}`);
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
      <div class="brand-logo">
        <span class="logo-icon">🌸</span>
        <h1 class="brand-title">HaruDrive</h1>
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
  <header class="navbar glass">
    <div class="nav-left">
      <div class="brand-logo" onclick="triggerSakuraSecret()" style="cursor:pointer;" title="Click Sakura 3x for Admin Mode">
        <span class="logo-icon">🌸</span>
        <span class="brand-title">HaruDrive</span>
      </div>
      <div class="badge-hf">HF Storage 8TB</div>
    </div>
    <div class="nav-right">
      <div class="search-box glass">
        <span class="search-icon">🔍</span>
        <input type="text" id="searchInput" placeholder="Global search across all files..." oninput="onSearchInput(this)" />
      </div>
      <button class="btn-icon glass btn-mirror-stealth" id="mirrorModalBtn" onclick="openMirrorModal()" title="Cloud Mirror (Admin Only)" style="display:none;">
        🚀 <span class="btn-text">Cloud Mirror</span>
      </button>
      <button class="btn-icon glass" id="darkToggle" onclick="toggleDark()" title="Toggle Dark / Light Mode">🌙</button>
      <a href="/logout" class="btn-icon glass" title="Logout">🚪</a>
    </div>
  </header>

  <main class="container">
    <div class="breadcrumb-bar glass" id="breadcrumbBar">
      <span class="crumb" onclick="navigateTo('')">🏠 Home</span>
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
        <h3 id="modalTitle" class="modal-title">Streaming Video</h3>
        <button class="btn-close" onclick="closeModal()">✕</button>
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
        <div class="mirror-header-title">
          <span style="font-size:1.5rem;">🚀</span>
          <div>
            <h3>Cloud-to-Cloud Mirror (Admin Only)</h3>
            <p class="subtitle">Sync Google Drive Folder/File to Hugging Face Dataset with 0% local bandwidth!</p>
          </div>
        </div>
        <button class="btn-close" onclick="closeMirrorModal()">✕</button>
      </div>
      <div class="modal-body">
        <div class="info-card">
          <span class="info-badge">Gigabit Server Speed</span>
          <p>Proses download dan upload berjalan 100% di cloud runner. Laptop atau HP bisa dimatikan setelah proses dimulai.</p>
        </div>

        <form id="mirrorForm" onsubmit="submitCloudMirror(event)">
          <div class="form-group">
            <label>Google Drive File / Folder URL or ID</label>
            <input type="text" id="mirrorGdriveUrl" placeholder="https://drive.google.com/drive/folders/... or File URL" required />
            <small>Pastikan share setting link GDrive adalah "Anyone with the link can view".</small>
          </div>
          <div class="form-group">
            <label>Target Folder in Hugging Face (Optional)</label>
            <input type="text" id="mirrorTargetPath" placeholder="e.g. Movies/2026 or leave empty for root" />
          </div>

          <div class="form-group pin-group">
            <label>🔐 Admin Security PIN</label>
            <input type="password" id="mirrorAdminPin" placeholder="Enter Admin PIN (6-digits)" required />
            <div class="remember-pin-wrap">
              <label class="cb-label">
                <input type="checkbox" id="rememberPinCb" /> Remember PIN on this device
              </label>
            </div>
          </div>

          <div class="form-actions">
            <button type="submit" id="startMirrorBtn" class="btn-primary">⚡ Start Cloud Mirror (GitHub Actions)</button>
          </div>
        </form>

        <div class="divider"><span>ATAU JIKA LIMIT GITHUB HABIS</span></div>

        <div class="colab-card">
          <div class="colab-info">
            <strong>Google Colab Runner (Unlimited Backup)</strong>
            <p>Jalankan script mirror di Google Colab (12 jam runtime gratis, kecepatan gigabit).</p>
          </div>
          <a href="https://colab.research.google.com/github/IlhamRomadon297/haru-drive/blob/main/tools/HaruDrive_Colab_Mirror.ipynb" target="_blank" class="btn-colab">
            ⚡ Open 1-Click Colab
          </a>
        </div>
      </div>
    </div>
  </div>

  <div id="toastOverlay" class="toast-overlay" style="display:none;"></div>
  `;
}

const EMBEDDED_CLIENT_JS = "\nlet currentPath = '';\nlet allFiles = [];\nlet searchDebounceTimer = null;\nlet isSearching = false;\nlet sakuraClickCount = 0;\nlet sakuraClickTimer = null;\n\n// ==========================================\n// File Listing & Navigation\n// ==========================================\nasync function loadFiles(path) {\n  if (path === undefined || path === null) path = '';\n  currentPath = path;\n  isSearching = false;\n  const listEl = document.getElementById('fileList');\n  if (!listEl) return;\n  listEl.innerHTML = '<div class=\"loading-state\"><div class=\"spinner\"></div><p>Fetching files from Hugging Face Storage...</p></div>';\n  \n  updateBreadcrumbs(path);\n\n  try {\n    const res = await fetch('/api/list?path=' + encodeURIComponent(path));\n    if (!res.ok) {\n      const errData = await res.json().catch(() => ({}));\n      throw new Error(errData.error || 'Failed to fetch directory');\n    }\n    const data = await res.json();\n    allFiles = data.files || [];\n    renderFiles(allFiles);\n  } catch (e) {\n    listEl.innerHTML = '<div class=\"loading-state\" style=\"color:#ef4444;\"><p>\u274c Error: ' + escapeHtml(e.message) + '</p></div>';\n  }\n}\n\nfunction renderFiles(files, isGlobalSearch = false) {\n  const listEl = document.getElementById('fileList');\n  if (!listEl) return;\n  if (!files || files.length === 0) {\n    listEl.innerHTML = '<div class=\"loading-state\"><p>' + (isGlobalSearch ? '\ud83d\udd0d No files matched your search' : '\ud83d\udcc2 Folder is empty') + '</p></div>';\n    return;\n  }\n\n  let html = '';\n  for (let i = 0; i < files.length; i++) {\n    const file = files[i];\n    const isDir = file.mimeType === 'application/vnd.google-apps.folder';\n    const isVideo = (file.mimeType && file.mimeType.startsWith('video/')) || /\\.(mp4|mkv|webm|avi|mov)$/i.test(file.name);\n    const icon = isDir ? '\ud83d\udcc1' : (isVideo ? '\ud83c\udfac' : '\ud83d\udcc4');\n    const fileUrl = '/file/' + file.id + '/' + encodeURIComponent(file.name);\n\n    let actionBtns = '';\n    if (isVideo) {\n      actionBtns += '<button class=\"btn-act play\" data-name=\"' + encodeURIComponent(file.name) + '\" data-url=\"' + encodeURIComponent(fileUrl) + '\" onclick=\"handlePlayClick(this)\">\u25b6 Play</button>';\n    }\n    if (!isDir) {\n      actionBtns += '<a href=\"' + fileUrl + '\" class=\"btn-act\" download>\u2b07</a>';\n      actionBtns += '<button class=\"btn-act\" data-url=\"' + window.location.origin + fileUrl + '\" onclick=\"handleCopyClick(this)\">\ud83d\udd17</button>';\n    }\n\n    let clickAttr = '';\n    if (isDir) {\n      clickAttr = 'data-path=\"' + encodeURIComponent(file.path) + '\" onclick=\"handleFolderClick(this)\"';\n    } else if (isVideo) {\n      clickAttr = 'data-name=\"' + encodeURIComponent(file.name) + '\" data-url=\"' + encodeURIComponent(fileUrl) + '\" onclick=\"handlePlayClick(this)\"';\n    } else {\n      clickAttr = 'data-url=\"' + fileUrl + '\" onclick=\"handleFileClick(this)\"';\n    }\n\n    const folderBadge = (isGlobalSearch && file.parentDir) \n      ? '<span class=\"parent-badge\" data-path=\"' + encodeURIComponent(file.parentDir) + '\" onclick=\"event.stopPropagation(); handleFolderClick(this)\">\ud83d\udcc1 ' + escapeHtml(file.parentDir) + '</span>' \n      : '';\n\n    html += '<div class=\"file-row ' + (isDir ? 'is-folder' : '') + '\">' +\n      '<div class=\"col-cb\">' +\n        (!isDir ? '<input type=\"checkbox\" class=\"item-cb\" value=\"' + window.location.origin + fileUrl + '\" onchange=\"updateBulkToolbar()\" />' : '') +\n      '</div>' +\n      '<div class=\"file-name-cell\" ' + clickAttr + '>' +\n        '<span class=\"file-icon\">' + icon + '</span>' +\n        '<div class=\"file-info-group\">' +\n          '<span class=\"file-title\">' + escapeHtml(file.name) + '</span>' +\n          folderBadge +\n        '</div>' +\n      '</div>' +\n      '<div class=\"file-size-cell\">' + (isDir ? '-' : formatBytes(file.size)) + '</div>' +\n      '<div class=\"file-date-cell\">' + formatDate(file.modifiedTime) + '</div>' +\n      '<div class=\"file-actions-cell\">' + actionBtns + '</div>' +\n    '</div>';\n  }\n  listEl.innerHTML = html;\n}\n\nfunction handleFolderClick(el) {\n  const path = decodeURIComponent(el.dataset.path || '');\n  const searchInput = document.getElementById('searchInput');\n  if (searchInput) searchInput.value = '';\n  navigateTo(path);\n}\n\nfunction handlePlayClick(el) {\n  const name = decodeURIComponent(el.dataset.name || '');\n  const url = decodeURIComponent(el.dataset.url || '');\n  openVideoModal(name, url);\n}\n\nfunction handleFileClick(el) {\n  const url = el.dataset.url || '';\n  if (url) window.open(url, '_blank');\n}\n\nfunction handleCopyClick(el) {\n  const url = el.dataset.url || '';\n  copyLink(url);\n}\n\nfunction navigateTo(path) {\n  window.history.pushState(null, '', path ? '?p=' + encodeURIComponent(path) : '/');\n  loadFiles(path);\n}\n\nfunction updateBreadcrumbs(path) {\n  const bar = document.getElementById('breadcrumbBar');\n  if (!bar) return;\n  if (!path) {\n    bar.innerHTML = '<span class=\"crumb-current\">\ud83c\udfe0 Home</span>';\n    return;\n  }\n  const parts = path.split('/');\n  let html = '<span class=\"crumb\" onclick=\"navigateTo(\\'\\')\">\ud83c\udfe0 Home</span>';\n  let accum = '';\n  for (let idx = 0; idx < parts.length; idx++) {\n    const p = parts[idx];\n    accum += (idx === 0 ? '' : '/') + p;\n    const isLast = idx === parts.length - 1;\n    html += ' <span class=\"crumb-sep\">/</span> ';\n    if (isLast) {\n      html += '<span class=\"crumb-current\">' + escapeHtml(p) + '</span>';\n    } else {\n      html += '<span class=\"crumb\" data-target=\"' + encodeURIComponent(accum) + '\" onclick=\"navigateTo(decodeURIComponent(this.dataset.target))\">' + escapeHtml(p) + '</span>';\n    }\n  }\n  bar.innerHTML = html;\n}\n\n// ==========================================\n// Realtime Global Search (D1 Database)\n// ==========================================\nfunction onSearchInput(input) {\n  const q = input.value.trim();\n  clearTimeout(searchDebounceTimer);\n  \n  if (!q) {\n    if (isSearching) {\n      isSearching = false;\n      updateBreadcrumbs(currentPath);\n      renderFiles(allFiles);\n    }\n    return;\n  }\n\n  searchDebounceTimer = setTimeout(async () => {\n    isSearching = true;\n    const listEl = document.getElementById('fileList');\n    if (listEl) {\n      listEl.innerHTML = '<div class=\"loading-state\"><div class=\"spinner\"></div><p>Searching globally across all folders...</p></div>';\n    }\n    \n    const bar = document.getElementById('breadcrumbBar');\n    if (bar) {\n      bar.innerHTML = '<span class=\"crumb-current\">\ud83d\udd0d Global Search: \"' + escapeHtml(q) + '\"</span> <button class=\"btn-clear-search\" onclick=\"clearSearch()\">\u2715 Clear</button>';\n    }\n\n    try {\n      const res = await fetch('/api/search?q=' + encodeURIComponent(q));\n      if (!res.ok) throw new Error('Search failed');\n      const data = await res.json();\n      renderFiles(data.files || [], true);\n    } catch (e) {\n      if (listEl) {\n        listEl.innerHTML = '<div class=\"loading-state\" style=\"color:#ef4444;\"><p>\u274c Search error: ' + escapeHtml(e.message) + '</p></div>';\n      }\n    }\n  }, 250);\n}\n\nfunction clearSearch() {\n  const input = document.getElementById('searchInput');\n  if (input) input.value = '';\n  isSearching = false;\n  updateBreadcrumbs(currentPath);\n  renderFiles(allFiles);\n}\n\n// ==========================================\n// Bulk Actions Toolbar\n// ==========================================\nfunction updateBulkToolbar() {\n  const checked = document.querySelectorAll('.item-cb:checked');\n  const bar = document.getElementById('bulkToolbar');\n  if (!bar) return;\n  if (checked.length > 0) {\n    bar.style.display = 'flex';\n    const countEl = document.getElementById('bulkCount');\n    if (countEl) countEl.textContent = checked.length + ' selected';\n  } else {\n    bar.style.display = 'none';\n  }\n}\n\nfunction toggleSelectAll(masterCb) {\n  document.querySelectorAll('.item-cb').forEach(cb => { cb.checked = masterCb.checked; });\n  updateBulkToolbar();\n}\n\nfunction deselectAll() {\n  document.querySelectorAll('.item-cb').forEach(cb => { cb.checked = false; });\n  const master = document.getElementById('selectAllCb');\n  if (master) master.checked = false;\n  updateBulkToolbar();\n}\n\nfunction copySelectedLinks() {\n  const selected = Array.from(document.querySelectorAll('.item-cb:checked')).map(cb => cb.value);\n  if (!selected.length) return;\n  navigator.clipboard.writeText(selected.join('\\n')).then(() => {\n    showToast('Copied ' + selected.length + ' links to clipboard! \ud83d\udccb');\n    deselectAll();\n  });\n}\n\nfunction copyLink(url) {\n  navigator.clipboard.writeText(url).then(() => { showToast('Link copied to clipboard! \ud83d\udd17'); });\n}\n\nasync function downloadSelected() {\n  const selected = Array.from(document.querySelectorAll('.item-cb:checked')).map(cb => cb.value);\n  if (!selected.length) return;\n  showToast('Starting batch download...');\n  for (let i = 0; i < selected.length; i++) {\n    const a = document.createElement('a');\n    a.href = selected[i];\n    a.download = '';\n    document.body.appendChild(a);\n    a.click();\n    document.body.removeChild(a);\n    await new Promise(r => setTimeout(r, 600));\n  }\n  deselectAll();\n}\n\n// ==========================================\n// Video Player Modal\n// ==========================================\nfunction openVideoModal(name, url) {\n  const titleEl = document.getElementById('modalTitle');\n  if (titleEl) titleEl.textContent = name;\n  const player = document.getElementById('videoPlayer');\n  if (player) {\n    player.src = url;\n    player.play().catch(() => {});\n  }\n  \n  const fullUrl = window.location.origin + url;\n  const cleanUrl = fullUrl.replace(/^https?:\\/\\//, '');\n  const footer = document.getElementById('modalFooter');\n  if (footer) {\n    footer.innerHTML = \n      '<a href=\"' + url + '\" class=\"btn-player\" download>\u2b07 Download Video</a>' +\n      '<button class=\"btn-player\" data-url=\"' + fullUrl + '\" onclick=\"handleCopyClick(this)\">\ud83d\udd17 Copy Stream Link</button>' +\n      '<a href=\"potplayer://' + fullUrl + '\" class=\"btn-player\">PotPlayer</a>' +\n      '<a href=\"vlc://' + fullUrl + '\" class=\"btn-player\">VLC iOS/Mac</a>' +\n      '<a href=\"iina://weblink?url=' + fullUrl + '\" class=\"btn-player\">IINA (Mac)</a>' +\n      '<a href=\"intent://' + cleanUrl + '#Intent;action=android.intent.action.VIEW;scheme=https;type=video/*;package=org.videolan.vlc;end\" class=\"btn-player\">VLC Android</a>' +\n      '<a href=\"intent://' + cleanUrl + '#Intent;action=android.intent.action.VIEW;scheme=https;type=video/*;package=com.mxtech.videoplayer.ad;end\" class=\"btn-player\">MX Player</a>';\n  }\n\n  const modal = document.getElementById('videoModal');\n  if (modal) modal.style.display = 'flex';\n}\n\nfunction closeModal() {\n  const modal = document.getElementById('videoModal');\n  if (modal) modal.style.display = 'none';\n  const player = document.getElementById('videoPlayer');\n  if (player) {\n    player.pause();\n    player.src = '';\n  }\n}\n\n// ==========================================\n// Stealth Mode & Admin Mirror Modal (PIN 290722 Protected)\n// ==========================================\nfunction triggerSakuraSecret() {\n  sakuraClickCount++;\n  clearTimeout(sakuraClickTimer);\n  sakuraClickTimer = setTimeout(() => { sakuraClickCount = 0; }, 2000);\n\n  if (sakuraClickCount >= 3) {\n    sakuraClickCount = 0;\n    revealAdminMirror();\n  }\n}\n\nfunction revealAdminMirror() {\n  const btn = document.getElementById('mirrorModalBtn');\n  if (btn) {\n    btn.style.display = 'inline-flex';\n  }\n  showToast('\u2728 Admin Mode Activated!');\n  openMirrorModal();\n}\n\n// Secret shortcut: Ctrl + Shift + M\nwindow.addEventListener('keydown', (e) => {\n  if (e.ctrlKey && e.shiftKey && (e.key === 'M' || e.key === 'm')) {\n    e.preventDefault();\n    revealAdminMirror();\n  }\n});\n\nfunction openMirrorModal() {\n  const pinInput = document.getElementById('mirrorAdminPin');\n  const savedPin = localStorage.getItem('harudrive_admin_pin');\n  if (pinInput && savedPin) {\n    pinInput.value = savedPin;\n    const rememberCb = document.getElementById('rememberPinCb');\n    if (rememberCb) rememberCb.checked = true;\n  }\n  const m = document.getElementById('mirrorModal');\n  if (m) m.style.display = 'flex';\n}\n\nfunction closeMirrorModal() {\n  const m = document.getElementById('mirrorModal');\n  if (m) m.style.display = 'none';\n}\n\nasync function submitCloudMirror(e) {\n  e.preventDefault();\n  const gdriveInput = document.getElementById('mirrorGdriveUrl');\n  const targetInput = document.getElementById('mirrorTargetPath');\n  const pinInput = document.getElementById('mirrorAdminPin');\n  const rememberCb = document.getElementById('rememberPinCb');\n\n  const gdrive_url = gdriveInput ? gdriveInput.value.trim() : '';\n  const target_path = targetInput ? targetInput.value.trim() : '';\n  const admin_pin = pinInput ? pinInput.value.trim() : '';\n\n  if (!admin_pin) {\n    alert('\u26a0\ufe0f Harap masukkan Admin PIN untuk memulai mirror.');\n    if (pinInput) pinInput.focus();\n    return;\n  }\n\n  const btn = document.getElementById('startMirrorBtn');\n  if (btn) {\n    btn.disabled = true;\n    btn.textContent = '\ud83d\ude80 Verifying PIN & Dispatching...';\n  }\n\n  try {\n    const res = await fetch('/api/admin/mirror', {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ gdrive_url: gdrive_url, target_path: target_path, admin_pin: admin_pin })\n    });\n    const result = await res.json();\n    if (res.ok && result.success) {\n      if (rememberCb && rememberCb.checked) {\n        localStorage.setItem('harudrive_admin_pin', admin_pin);\n      } else {\n        localStorage.removeItem('harudrive_admin_pin');\n      }\n      alert('\u2705 SUCCESS!\\n\\n' + result.message + '\\n\\nProses mirror sedang berjalan di GitHub Actions Cloud.');\n      closeMirrorModal();\n    } else {\n      alert('\u274c Akses Ditolak: ' + (result.error || 'PIN Admin Salah atau gagal dispatch job.'));\n      if (pinInput) {\n        pinInput.focus();\n        pinInput.select();\n      }\n    }\n  } catch (err) {\n    alert('\u274c Error: ' + err.message);\n  } finally {\n    if (btn) {\n      btn.disabled = false;\n      btn.textContent = '\u26a1 Start Cloud Mirror (GitHub Actions)';\n    }\n  }\n}\n\n// ==========================================\n// Utilities & Init\n// ==========================================\nfunction showToast(msg) {\n  const toast = document.getElementById('toastOverlay');\n  if (!toast) return;\n  toast.textContent = msg;\n  toast.style.display = 'block';\n  setTimeout(() => { toast.style.display = 'none'; }, 3000);\n}\n\nfunction toggleDark() {\n  const isLight = document.body.classList.toggle('light');\n  localStorage.setItem('haruTheme', isLight ? 'light' : 'dark');\n  const toggle = document.getElementById('darkToggle');\n  if (toggle) toggle.textContent = isLight ? '\ud83c\udf19' : '\u2600\ufe0f';\n}\n\nfunction formatBytes(bytes) {\n  if (!bytes || bytes === 0) return '0 B';\n  const k = 1024;\n  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];\n  const i = Math.floor(Math.log(bytes) / Math.log(k));\n  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];\n}\n\nfunction formatDate(dateStr) {\n  if (!dateStr) return '-';\n  const d = new Date(dateStr);\n  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });\n}\n\nfunction escapeHtml(str) {\n  return (str || '').replace(/[&<>\"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[m]));\n}\n\n// History back/forward navigation\nwindow.addEventListener('popstate', () => {\n  const params = new URLSearchParams(window.location.search);\n  loadFiles(params.get('p') || '');\n});\n\n// Initialization\nfunction initHaruDrive() {\n  if (localStorage.getItem('haruTheme') === 'light') {\n    document.body.classList.add('light');\n    const toggle = document.getElementById('darkToggle');\n    if (toggle) toggle.textContent = '\ud83c\udf19';\n  }\n  // Check if admin is saved, if so keep mirror button visible\n  if (localStorage.getItem('harudrive_admin_pin')) {\n    const btn = document.getElementById('mirrorModalBtn');\n    if (btn) btn.style.display = 'inline-flex';\n  }\n  const params = new URLSearchParams(window.location.search);\n  loadFiles(params.get('p') || '');\n}\n\nif (document.readyState === 'loading') {\n  document.addEventListener('DOMContentLoaded', initHaruDrive);\n} else {\n  initHaruDrive();\n}\n";

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
      --accent-gradient: linear-gradient(135deg, #ec4899 0%, #8b5cf6 50%, #6366f1 100%);
      --bg: #0b0f19;
      --bg-surface: rgba(18, 24, 38, 0.75);
      --bg-card: rgba(23, 32, 51, 0.85);
      --border: rgba(255, 255, 255, 0.08);
      --border-focus: rgba(99, 102, 241, 0.5);
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --hover-row: rgba(99, 102, 241, 0.08);
      --radius: 14px;
      --radius-sm: 8px;
      --font: 'Plus Jakarta Sans', -apple-system, sans-serif;
    }

    body.light {
      --bg: #f8fafc;
      --bg-surface: rgba(255, 255, 255, 0.85);
      --bg-card: rgba(255, 255, 255, 0.95);
      --border: rgba(0, 0, 0, 0.08);
      --border-focus: rgba(99, 102, 241, 0.5);
      --text: #0f172a;
      --text-muted: #64748b;
      --text-dim: #94a3b8;
      --hover-row: rgba(99, 102, 241, 0.05);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font);
      background-color: var(--bg);
      background-image: radial-gradient(at 0% 0%, rgba(236, 72, 153, 0.12) 0px, transparent 50%),
                        radial-gradient(at 100% 100%, rgba(99, 102, 241, 0.12) 0px, transparent 50%);
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

    .navbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 28px;
      position: sticky;
      top: 0;
      z-index: 100;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
    }
    .nav-left, .nav-right { display: flex; align-items: center; gap: 14px; }
    .brand-logo {
      display: flex;
      align-items: center;
      gap: 10px;
      user-select: none;
    }
    .logo-icon { font-size: 1.6rem; transition: transform 0.2s; }
    .brand-logo:hover .logo-icon { transform: scale(1.15) rotate(15deg); }
    .brand-title {
      font-size: 1.35rem;
      font-weight: 800;
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
    }
    .badge-hf {
      font-size: 0.72rem;
      font-weight: 700;
      padding: 4px 8px;
      border-radius: 20px;
      background: rgba(236, 72, 153, 0.15);
      color: #f43f5e;
      border: 1px solid rgba(236, 72, 153, 0.3);
    }

    .search-box {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 24px;
      width: 280px;
    }
    .search-box input {
      background: transparent;
      border: none;
      outline: none;
      color: var(--text);
      font-family: inherit;
      font-size: 0.88rem;
      width: 100%;
    }

    .btn-icon {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 24px;
      color: var(--text);
      text-decoration: none;
      font-size: 0.88rem;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border);
      transition: all 0.2s;
    }
    .btn-icon:hover {
      border-color: var(--primary-light);
      background: rgba(99, 102, 241, 0.15);
    }
    .btn-mirror-stealth {
      background: rgba(236, 72, 153, 0.12);
      border-color: rgba(236, 72, 153, 0.3);
      color: #f43f5e;
    }

    .container {
      max-width: 1200px;
      width: 100%;
      margin: 24px auto;
      padding: 0 20px;
      flex: 1;
    }

    .breadcrumb-bar {
      padding: 12px 18px;
      border-radius: var(--radius);
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.9rem;
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
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
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

    .modal-backdrop {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(8px);
      z-index: 200;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .modal-card {
      width: 100%;
      max-width: 650px;
      border-radius: var(--radius);
      background: var(--bg-card);
      overflow: hidden;
      box-shadow: 0 20px 50px rgba(0,0,0,0.5);
    }
    .video-card { max-width: 850px; }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 18px 24px;
      border-bottom: 1px solid var(--border);
    }
    .btn-close {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 1.2rem;
      cursor: pointer;
    }
    .modal-body { padding: 24px; }
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
      border-top: 1px solid var(--border);
    }
    .btn-player {
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text);
      text-decoration: none;
      font-size: 0.82rem;
      font-weight: 600;
      transition: all 0.2s;
    }
    .btn-player:hover {
      border-color: var(--primary-light);
      background: var(--primary);
      color: white;
    }

    .form-group { margin-bottom: 16px; }
    .form-group label {
      display: block;
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 6px;
      color: var(--text-muted);
    }
    .form-group input {
      width: 100%;
      padding: 10px 14px;
      border-radius: var(--radius-sm);
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text);
      font-family: inherit;
      font-size: 0.9rem;
      outline: none;
    }
    .form-group input:focus { border-color: var(--primary); }
    .form-group small { display: block; margin-top: 4px; font-size: 0.75rem; color: var(--text-dim); }

    .pin-group {
      background: rgba(236, 72, 153, 0.08);
      border: 1px solid rgba(236, 72, 153, 0.2);
      padding: 14px;
      border-radius: var(--radius-sm);
    }
    .remember-pin-wrap {
      margin-top: 8px;
      display: flex;
      align-items: center;
    }
    .cb-label {
      font-size: 0.8rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }

    .btn-primary {
      width: 100%;
      padding: 12px;
      border-radius: var(--radius-sm);
      border: none;
      background: var(--accent-gradient);
      color: white;
      font-weight: 700;
      font-size: 0.95rem;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .btn-primary:hover { opacity: 0.9; }

    .info-card {
      background: rgba(99, 102, 241, 0.1);
      border: 1px solid rgba(99, 102, 241, 0.2);
      padding: 12px 16px;
      border-radius: var(--radius-sm);
      margin-bottom: 18px;
    }
    .info-badge {
      display: inline-block;
      font-size: 0.72rem;
      font-weight: 800;
      text-transform: uppercase;
      padding: 2px 6px;
      background: var(--primary);
      color: white;
      border-radius: 4px;
      margin-bottom: 4px;
    }
    .info-card p { font-size: 0.82rem; color: var(--text-muted); line-height: 1.4; }

    .divider {
      text-align: center;
      position: relative;
      margin: 20px 0;
    }
    .divider::before {
      content: '';
      position: absolute;
      left: 0; top: 50%;
      width: 100%; height: 1px;
      background: var(--border);
    }
    .divider span {
      position: relative;
      background: var(--bg-card);
      padding: 0 10px;
      font-size: 0.7rem;
      font-weight: 700;
      color: var(--text-dim);
    }

    .colab-card {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 18px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-surface);
    }
    .colab-info p { font-size: 0.78rem; color: var(--text-dim); }
    .btn-colab {
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      background: #f59e0b;
      color: #000;
      font-weight: 700;
      font-size: 0.85rem;
      text-decoration: none;
      white-space: nowrap;
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
      z-index: 300;
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
