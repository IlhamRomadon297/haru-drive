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
