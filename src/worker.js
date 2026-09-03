export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const HF_REPO_ID = env.HF_REPO_ID || 'username/harudrive-data';
    const HF_TOKEN = env.HF_TOKEN || '';
    const APP_PASSWORD = env.APP_PASSWORD || 'not_set_in_env';
    const ADMIN_PIN = env.ADMIN_PIN || 'not_set_in_env';
    const GITHUB_PAT = env.GITHUB_PAT || '';
    const GITHUB_REPO = env.GITHUB_REPO || 'IlhamRomadon297/haru-drive';
    const GDRIVE_CLIENT_ID = env.GDRIVE_CLIENT_ID || '';
    const GDRIVE_CLIENT_SECRET = env.GDRIVE_CLIENT_SECRET || '';
    const GDRIVE_REFRESH_TOKEN = env.GDRIVE_REFRESH_TOKEN || '';
    const GDRIVE_ROOT_ID = env.GDRIVE_ROOT_ID || '1Sq1JHBCQ9REXWyhpvdjfwwJP7HJCB7Z9';

    // Best-effort background sync: keeps the D1 search index fresh automatically.
    // Only triggered on page loads (not /api/*) to avoid D1 write contention with file listing.
    if (!url.pathname.startsWith('/api/')) {
      ctx.waitUntil(maybeAutoSync(env));
    }

    const cookie = request.headers.get('Cookie') || '';
    const isLoggedIn = cookie.includes('harudrive_auth=true');

    // Already authenticated -> go straight to the file manager.
    if (url.pathname === '/login' && isLoggedIn) {
      return new Response(null, { status: 302, headers: { 'Location': '/' } });
    }

    // ---- LOGIN PAGE ----
    if (url.pathname === '/login') {
      if (request.method === 'POST') {
        const formData = await request.formData();
        const password = formData.get('password');
        if (password === APP_PASSWORD) {
          return new Response('Logged in', {
            status: 302,
            headers: {
              'Location': '/',
              'Set-Cookie': 'harudrive_auth=true; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800'
            }
          });
        } else {
          return new Response(htmlPage(loginUI('Password salah. Silakan coba lagi.'), env, 'login'), {
            headers: { 'Content-Type': 'text/html;charset=UTF-8' }
          });
        }
      }
      return new Response(htmlPage(loginUI(), env, 'login'), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // ---- LOGOUT ----
    if (url.pathname === '/logout') {
      return new Response('Logged out', {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': 'harudrive_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
        }
      });
    }

    // ---- PUBLIC / GUEST ROUTES (no login): shared-folder links + read-only APIs ----
    const isPublicGet = request.method === 'GET' && (
      (url.pathname === '/' && url.searchParams.has('p')) ||
      url.pathname === '/api/list' ||
      url.pathname === '/api/folders' ||
      url.pathname === '/api/search' ||
      url.pathname.startsWith('/folder/') ||
      url.pathname.startsWith('/file/') ||
      url.pathname.startsWith('/d/') ||
      url.pathname.startsWith('/raw/') ||
      url.pathname.startsWith('/static/') ||
      url.pathname.endsWith('.ico') ||
      url.pathname.endsWith('.png')
    );

    // Page routes (GET, not public, not API) require an authenticated session.
    // If not logged in -> bounce to the login page.
    const isPageRoute = request.method === 'GET' && !isPublicGet && !url.pathname.startsWith('/api/');
    if (isPageRoute && !isLoggedIn) {
      return new Response(null, {
        status: 302,
        headers: { 'Location': '/login' }
      });
    }

    // Admin / write APIs require login -> 401 JSON when not authenticated.
    const isProtectedApi = url.pathname.startsWith('/api/') && !isPublicGet;
    if (isProtectedApi && !isLoggedIn) {
      return new Response(JSON.stringify({ error: 'Unauthorized. Admin login required.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // API: Available Folders (100% Live Hugging Face Tree)
    if (url.pathname === '/api/folders') {
      try {
        const repoId = HF_REPO_ID;
        const hfTreeUrl = `https://huggingface.co/api/datasets/${repoId}/tree/main?recursive=true`;
        const hfHeaders = { 'User-Agent': 'HaruDrive/1.0' };
        if (HF_TOKEN) hfHeaders['Authorization'] = `Bearer ${HF_TOKEN}`;

        const hfRes = await fetch(hfTreeUrl, { headers: hfHeaders });
        const folderSet = new Set(['']);

        if (hfRes.ok) {
          const items = await hfRes.json();
          items.forEach(item => {
            if (item.type === 'directory' && !item.path.startsWith('.')) {
              folderSet.add(item.path);
            }
          });
        }

        const sortedFolders = Array.from(folderSet).sort((a, b) => a.localeCompare(b));
        return new Response(JSON.stringify({ folders: sortedFolders }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ folders: [''] }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // API: Global Search
    if (url.pathname === '/api/search') {
      try {
        const searchMode = url.searchParams.get('mode') || request.headers.get('X-Storage-Mode') || '';
        if (searchMode === 'gdrive') {
          const gQ = (url.searchParams.get('q') || '').trim();
          if (!gQ) return new Response(JSON.stringify({ query: '', files: [] }), { headers: { 'Content-Type': 'application/json' } });
          const parentId = url.searchParams.get('parentId') || url.searchParams.get('folderId') || '';
          let gFiles;
          if (parentId) {
            // Local search: list current folder and filter by name (direct children only)
            try { const inFolder = await listGDriveFolder(parentId, env); gFiles = inFolder.filter(f => f.name.toLowerCase().includes(gQ.toLowerCase())); } catch(e) { gFiles = await searchGDrive(gQ, env); }
          } else {
            // No parent specified, fallback to global search (should not happen in GDrive local mode, but keep as fallback)
            gFiles = await searchGDrive(gQ, env);
          }
          const formatted = gFiles.map(f => ({ id: f.id, path: f.id, name: f.name, mimeType: f.mimeType, size: f.size, modifiedTime: f.modifiedTime, parentDir: '' }));
          return new Response(JSON.stringify({ query: gQ, files: formatted }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }
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

    // API: List Files
    if (url.pathname === '/api/list') {
      try {
        const listMode = url.searchParams.get('mode') || request.headers.get('X-Storage-Mode') || '';
        if (listMode === 'gdrive') {
          let gFolderId = url.searchParams.get('id') || url.searchParams.get('path') || '';
          // Resolve shortId -> Drive ID if needed (for GDrive shortId links)
          let realGFolderId = gFolderId;
          if (gFolderId && gFolderId.length === 8 && env.harudrive_db) {
            try { const r = await env.harudrive_db.prepare('SELECT file_path FROM shortlinks WHERE short_id = ?').bind(gFolderId).first(); if (r && r.file_path && r.file_path.length > 20) realGFolderId = r.file_path; } catch(e) {}
          }
          if (!realGFolderId) realGFolderId = GDRIVE_ROOT_ID;
          let folderDisplayName = 'GDrive';
          let displayPath = '';
          if (realGFolderId !== GDRIVE_ROOT_ID) {
            try {
              const tkn2 = await getGDriveAccessToken(env);
              if (tkn2) {
                const metaRes2 = await fetch('https://www.googleapis.com/drive/v3/files/' + realGFolderId + '?fields=name&supportsAllDrives=true', { headers: { 'Authorization': 'Bearer ' + tkn2 } });
                if (metaRes2.ok) { const meta2 = await metaRes2.json(); if (meta2.name) { folderDisplayName = meta2.name; displayPath = meta2.name; } }
              }
            } catch(e) {}
          }
          const gFiles = await listGDriveFolder(realGFolderId, env);
          // Generate shortIds for GDrive files/folders to hide real Drive IDs (fallback to real ID if D1 write limit hit)
          const gFormatted = [];
          for (const f of gFiles) {
            let shortId;
            try { shortId = await generateShortId('gdrive:' + f.id); } catch(e) { shortId = f.id; }
            const fType = f.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file';
            let useShortId = true;
            try { await env.harudrive_db.prepare('INSERT OR REPLACE INTO shortlinks (short_id, file_path, name, type, size) VALUES (?, ?, ?, ?, ?)').bind(shortId, f.id, f.name, fType, f.size).run(); } catch(e) { useShortId = false; }
            const finalId = useShortId ? shortId : f.id;
            gFormatted.push({ id: finalId, path: finalId, name: f.name, mimeType: f.mimeType, size: f.size, modifiedTime: f.modifiedTime });
          }
          gFormatted.sort((a,b) => {
            const aIsDir = a.mimeType === 'application/vnd.google-apps.folder';
            const bIsDir = b.mimeType === 'application/vnd.google-apps.folder';
            if (aIsDir && !bIsDir) return -1;
            if (!aIsDir && bIsDir) return 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true });
          });
          // For folder sizes in GDrive, we can compute directly from the listed files (not recursive via D1)
          return new Response(JSON.stringify({ folderName: folderDisplayName, currentPath: displayPath, folderId: realGFolderId, files: gFormatted, folderStats: { fileCount: gFiles.filter(f => f.mimeType !== 'application/vnd.google-apps.folder').length, fileSize: gFiles.filter(f => f.mimeType !== 'application/vnd.google-apps.folder').reduce((s,f)=>s+f.size,0) } }), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }
        let reqPath = url.searchParams.get('path') || '';
        const folderId = url.searchParams.get('id') || '';

        if (folderId && env.harudrive_db) {
          const row = await env.harudrive_db.prepare('SELECT file_path FROM shortlinks WHERE short_id = ?').bind(folderId).first();
          if (row && row.file_path) {
            reqPath = row.file_path;
          }
        }

        reqPath = reqPath.replace(/^\/+|\/+$/g, '');

        const repoId = HF_REPO_ID;
        const hfTreeUrl = reqPath 
          ? `https://huggingface.co/api/datasets/${repoId}/tree/main/${encodeURI(reqPath)}`
          : `https://huggingface.co/api/datasets/${repoId}/tree/main`;

        const hfHeaders = { 'User-Agent': 'HaruDrive/1.0' };
        if (HF_TOKEN) hfHeaders['Authorization'] = `Bearer ${HF_TOKEN}`;

        const hfRes = await fetch(hfTreeUrl, { headers: hfHeaders });
        if (!hfRes.ok) {
          const errText = await hfRes.text();
          return new Response(JSON.stringify({ error: `Hugging Face error (${hfRes.status}): ${errText}` }), {
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

        let currentFolderId = '';
        if (reqPath) {
          currentFolderId = await generateShortId(reqPath);
        }

        // Fill recursive folder sizes (from the D1 folder_sizes index) + current folder stats.
        let folderStats = { fileCount: 0, fileSize: 0 };
        if (env.harudrive_db) {
          try {
            const dirSizeMap = new Map();
            const fsRes = await env.harudrive_db.prepare('SELECT path, size, files FROM folder_sizes').all();
            (fsRes.results || []).forEach(r => dirSizeMap.set(r.path, { size: r.size || 0, files: r.files || 0 }));
            formattedFiles.forEach(f => {
              if (f.mimeType === 'application/vnd.google-apps.folder') {
                const s = dirSizeMap.get(f.path);
                f.size = s ? s.size : 0;
                f.fileCount = s ? s.files : 0;
              }
            });
            const cur = dirSizeMap.get(reqPath);
            if (cur) folderStats = { fileCount: cur.files, fileSize: cur.size };
          } catch (e) {}
        }

        return new Response(JSON.stringify({ folderName, currentPath: reqPath, folderId: currentFolderId, files: formattedFiles, folderStats }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // API: Admin Manual File Upload
    if (url.pathname === '/api/admin/upload' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const pin = formData.get('admin_pin');
        if (pin !== ADMIN_PIN) {
          return new Response(JSON.stringify({ error: 'PIN Admin Salah!' }), { status: 403 });
        }

        const file = formData.get('file');
        const targetDir = (formData.get('target_dir') || '').replace(/^\/+|\/+$/g, '');
        if (!file || typeof file === 'string') {
          return new Response(JSON.stringify({ error: 'Tidak ada file yang dipilih.' }), { status: 400 });
        }

        const filename = file.name;
        const fullPath = targetDir ? `${targetDir}/${filename}` : filename;

        const arrayBuffer = await file.arrayBuffer();
        const uint8 = new Uint8Array(arrayBuffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < uint8.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, uint8.subarray(i, i + chunkSize));
        }
        const base64Content = btoa(binary);

        const commitUrl = `https://huggingface.co/api/datasets/${HF_REPO_ID}/commit/main`;
        const lines = [
          JSON.stringify({ key: 'header', value: { summary: `Upload ${filename} via HaruDrive`, description: '' } }),
          JSON.stringify({ key: 'file', value: { content: base64Content, path: fullPath, encoding: 'base64' } })
        ];
        const ndjsonBody = lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
        const hfRes = await fetch(commitUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${HF_TOKEN}`,
            'Content-Type': 'application/x-ndjson'
          },
          body: ndjsonBody
        });

        if (!hfRes.ok) {
          const errText = await hfRes.text();
          return new Response(JSON.stringify({ error: `Gagal upload ke HF: ${errText}` }), { status: hfRes.status });
        }

        const shortId = await generateShortId(fullPath);
        if (env.harudrive_db) {
          await env.harudrive_db.prepare(
            'INSERT OR REPLACE INTO shortlinks (short_id, file_path, name, type, size) VALUES (?, ?, ?, ?, ?)'
          ).bind(shortId, fullPath, filename, 'file', file.size || 0).run();
        }

        return new Response(JSON.stringify({ success: true, path: fullPath, shortId }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // API: Fetch Cloud Mirror Tasks
    if (url.pathname === '/api/admin/mirror-tasks') {
      try {
        const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/runs?per_page=10`, {
          headers: {
            'Authorization': `Bearer ${GITHUB_PAT}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'HaruDrive-Admin'
          }
        });

        if (!ghRes.ok) {
          const errText = await ghRes.text();
          return new Response(JSON.stringify({ error: `GitHub API error: ${errText}` }), { status: ghRes.status });
        }

        const data = await ghRes.json();
        const runs = (data.workflow_runs || []).map(r => ({
          id: r.id,
          name: r.name || 'Cloud Mirror Runner',
          status: r.status,
          conclusion: r.conclusion,
          created_at: r.created_at,
          updated_at: r.updated_at,
          html_url: r.html_url,
          display_title: r.display_title || r.name
        }));

        const hasActive = runs.some(r => r.status === 'in_progress' || r.status === 'queued');

        return new Response(JSON.stringify({ runs, hasActive }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // API: Cancel Mirror Task
    if (url.pathname === '/api/admin/cancel-task' && request.method === 'POST') {
      try {
        const body = await request.json();
        const pin = body.admin_pin || '';
        if (pin !== ADMIN_PIN) {
          return new Response(JSON.stringify({ error: 'PIN Admin Salah!' }), { status: 403 });
        }

        const runId = body.run_id;
        if (!runId) {
          return new Response(JSON.stringify({ error: 'Run ID wajib diisi.' }), { status: 400 });
        }

        const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/actions/runs/${runId}/cancel`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GITHUB_PAT}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'HaruDrive-Admin'
          }
        });

        return new Response(JSON.stringify({ success: ghRes.status === 202 }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // API: Sync full HF index into D1 (bulk global-search index)
    if (url.pathname === '/api/admin/sync' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (body.admin_pin !== ADMIN_PIN) {
          return new Response(JSON.stringify({ error: 'PIN Admin Salah!' }), { status: 403 });
        }
        const result = await syncIndex(env);
        await recordLastSync(env);
        return new Response(JSON.stringify({ success: true, items: result.items, truncated: result.truncated }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // API: MediaInfo (4-layer cache)
    if (url.pathname === '/api/mediainfo') {
      try {
        await env.harudrive_db.prepare('CREATE TABLE IF NOT EXISTS mediainfo_cache (path TEXT PRIMARY KEY, raw TEXT, json TEXT, updated INTEGER)').run();
        if (request.method === 'GET') {
          const qPath = url.searchParams.get('path') || '';
          const qId = url.searchParams.get('id') || '';
          let lookupPath = qPath;
          if (!lookupPath && qId && env.harudrive_db) {
            const r = await env.harudrive_db.prepare('SELECT file_path FROM shortlinks WHERE short_id = ?').bind(qId).first();
            if (r && r.file_path) lookupPath = r.file_path;
            else lookupPath = qId;
          }
          lookupPath = (lookupPath || '').replace(/^\/+|\/+$/g, '');
          if (!lookupPath) return new Response(JSON.stringify({ error: 'path or id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          const row = await env.harudrive_db.prepare('SELECT raw, json, updated FROM mediainfo_cache WHERE path = ?').bind(lookupPath).first();
          if (!row) return new Response(JSON.stringify({ success: true, cached: false, mediainfo_raw: null, mediainfo_json: null }), { headers: { 'Content-Type': 'application/json' } });
          let parsed = null;
          if (row.json) { try { parsed = JSON.parse(row.json); } catch(e) {} }
          return new Response(JSON.stringify({ success: true, cached: true, mediainfo_raw: row.raw || null, mediainfo_json: parsed }), { headers: { 'Content-Type': 'application/json' } });
        } else if (request.method === 'POST' || request.method === 'PUT') {
          const body = await request.json().catch(() => ({}));
          let p = (body.path || url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
          const qId = body.id || url.searchParams.get('id') || '';
          if (!p && qId && env.harudrive_db) {
            const r = await env.harudrive_db.prepare('SELECT file_path FROM shortlinks WHERE short_id = ?').bind(qId).first();
            if (r && r.file_path) p = r.file_path;
            else p = qId;
            p = p.replace(/^\/+|\/+$/g, '');
          }
          if (!p) return new Response(JSON.stringify({ error: 'path required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
          const raw = body.mediainfo_raw || body.raw || null;
          const j = body.mediainfo_json || body.json || null;
          const jStr = j ? (typeof j === 'string' ? j : JSON.stringify(j)) : null;
          await env.harudrive_db.prepare('INSERT OR REPLACE INTO mediainfo_cache (path, raw, json, updated) VALUES (?, ?, ?, ?)').bind(p, raw, jStr, Date.now()).run();
          return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // API: Bandwidth stats (admin only)
    if (url.pathname === '/api/bandwidth') {
      const bCookie = request.headers.get('Cookie') || '';
      const bLoggedIn = bCookie.includes('harudrive_auth=true');
      if (!bLoggedIn) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      try {
        const bMode = url.searchParams.get('mode') || '';
        if (bMode) {
          const row = await env.harudrive_db.prepare('SELECT mode, bytes, requests, updated FROM bandwidth_stats WHERE mode = ?').bind(bMode).first().catch(() => null);
          if (!row) return new Response(JSON.stringify({ mode: bMode, stats: { mode: bMode, bytes: 0, requests: 0 } }), { headers: { 'Content-Type': 'application/json' } });
          return new Response(JSON.stringify({ mode: bMode, stats: row }), { headers: { 'Content-Type': 'application/json' } });
        } else {
          const rows = await env.harudrive_db.prepare('SELECT mode, bytes, requests, updated FROM bandwidth_stats').all().catch(() => ({ results: [] }));
          return new Response(JSON.stringify({ stats: rows.results || [] }), { headers: { 'Content-Type': 'application/json' } });
        }
      } catch(e) { return new Response(JSON.stringify({ stats: [] }), { headers: { 'Content-Type': 'application/json' } }); }
    }

    // API: Start Cloud Mirror
    if (url.pathname === '/api/admin/mirror' && request.method === 'POST') {
      try {
        const body = await request.json();
        const pin = body.admin_pin || '';
        if (pin !== ADMIN_PIN) {
          return new Response(JSON.stringify({ error: 'PIN Admin Salah!' }), { status: 403 });
        }

        const gdriveUrl = (body.gdrive_url || '').trim();
        const targetPath = (body.target_path || '').trim();
        if (!gdriveUrl) {
          return new Response(JSON.stringify({ error: 'GDRIVE_URL wajib diisi.' }), { status: 400 });
        }

        const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${GITHUB_PAT}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'HaruDrive-Admin',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            event_type: 'gdrive_mirror',
            client_payload: {
              gdrive_url: gdriveUrl,
              target_path: targetPath,
              hf_repo: HF_REPO_ID
            }
          })
        });

        if (ghRes.status === 204) {
          return new Response(JSON.stringify({
            success: true,
            message: 'Cloud Mirror berhasil dijalankan di GitHub Actions!',
            repo: GITHUB_REPO,
            target_path: targetPath
          }), { headers: { 'Content-Type': 'application/json' } });
        } else {
          const errText = await ghRes.text();
          return new Response(JSON.stringify({ error: `GitHub dispatch error (${ghRes.status}): ${errText}` }), { status: ghRes.status });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // API: Mkdir
    if (url.pathname === '/api/admin/mkdir' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (body.admin_pin !== ADMIN_PIN) {
          return new Response(JSON.stringify({ error: 'PIN Admin Salah!' }), { status: 403 });
        }

        const folderPath = (body.folder_path || '').replace(/^\/+|\/+$/g, '');
        if (!folderPath) {
          return new Response(JSON.stringify({ error: 'Path folder tidak boleh kosong.' }), { status: 400 });
        }

        const commitUrl = `https://huggingface.co/api/datasets/${HF_REPO_ID}/commit/main`;
        const lines = [
          JSON.stringify({ key: 'header', value: { summary: `Create folder ${folderPath} via HaruDrive`, description: '' } }),
          JSON.stringify({ key: 'file', value: { content: '', path: `${folderPath}/.gitkeep`, encoding: 'utf-8' } })
        ];
        const ndjsonBody = lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
        const hfRes = await fetch(commitUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${HF_TOKEN}`,
            'Content-Type': 'application/x-ndjson'
          },
          body: ndjsonBody
        });

        if (!hfRes.ok) {
          const errText = await hfRes.text();
          return new Response(JSON.stringify({ error: `Gagal membuat folder di HF: ${errText}` }), { status: hfRes.status });
        }

        const shortId = await generateShortId(folderPath);
        if (env.harudrive_db) {
          const folderName = folderPath.split('/').pop();
          await env.harudrive_db.prepare(
            'INSERT OR REPLACE INTO shortlinks (short_id, file_path, name, type, size) VALUES (?, ?, ?, ?, ?)'
          ).bind(shortId, folderPath, folderName, 'folder', 0).run();
        }

        return new Response(JSON.stringify({ success: true, folderId: shortId, folderPath }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // API: Rename (Atomic NDJSON Protocol)
    if (url.pathname === '/api/admin/rename' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (body.admin_pin !== ADMIN_PIN) {
          return new Response(JSON.stringify({ error: 'PIN Admin Salah!' }), { status: 403 });
        }

        const oldPath = (body.old_path || '').replace(/^\/+|\/+$/g, '');
        const newPath = (body.new_path || '').replace(/^\/+|\/+$/g, '');
        if (!oldPath || !newPath) {
          return new Response(JSON.stringify({ error: 'Path lama dan baru wajib diisi.' }), { status: 400 });
        }

        const treeRes = await fetch(`https://huggingface.co/api/datasets/${HF_REPO_ID}/tree/main?recursive=true`, {
          headers: { 'Authorization': `Bearer ${HF_TOKEN}` }
        });
        const treeItems = treeRes.ok ? await treeRes.json() : [];

        const lines = [
          JSON.stringify({ key: 'header', value: { summary: `Rename ${oldPath} to ${newPath} via HaruDrive`, description: '' } })
        ];

        let matched = 0;
        let isDirectory = false;

        treeItems.forEach(item => {
          if (item.type === 'file') {
            if (item.path === oldPath) {
              matched++;
              lines.push(JSON.stringify({ key: 'deletedFile', value: { path: oldPath } }));
              if (item.lfs && item.lfs.oid) {
                lines.push(JSON.stringify({ key: 'lfsFile', value: { path: newPath, algo: 'sha256', oid: item.lfs.oid, size: item.lfs.size || item.size } }));
              } else {
                lines.push(JSON.stringify({ key: 'file', value: { path: newPath, content: '', encoding: 'utf-8' } }));
              }
            } else if (item.path.startsWith(oldPath + '/')) {
              matched++;
              isDirectory = true;
              const subPath = item.path.substring(oldPath.length + 1);
              const targetItemPath = `${newPath}/${subPath}`;
              lines.push(JSON.stringify({ key: 'deletedFile', value: { path: item.path } }));
              if (item.lfs && item.lfs.oid) {
                lines.push(JSON.stringify({ key: 'lfsFile', value: { path: targetItemPath, algo: 'sha256', oid: item.lfs.oid, size: item.lfs.size || item.size } }));
              } else {
                lines.push(JSON.stringify({ key: 'file', value: { path: targetItemPath, content: '', encoding: 'utf-8' } }));
              }
            }
          }
        });

        if (matched === 0) {
          lines.push(JSON.stringify({ key: 'deletedFolder', value: { path: oldPath } }));
          lines.push(JSON.stringify({ key: 'file', value: { path: `${newPath}/.gitkeep`, content: '', encoding: 'utf-8' } }));
        }

        const commitUrl = `https://huggingface.co/api/datasets/${HF_REPO_ID}/commit/main`;
        const ndjsonBody = lines.join(String.fromCharCode(10)) + String.fromCharCode(10);

        const hfRes = await fetch(commitUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${HF_TOKEN}`,
            'Content-Type': 'application/x-ndjson'
          },
          body: ndjsonBody
        });

        if (!hfRes.ok) {
          const errText = await hfRes.text();
          return new Response(JSON.stringify({ error: `Gagal rename di HF: ${errText}` }), { status: hfRes.status });
        }

        if (env.harudrive_db) {
          const newName = newPath.split('/').pop();
          const newShortId = await generateShortId(newPath);
          const oldPrefix = oldPath + '/';
          try {
            await env.harudrive_db.prepare('DELETE FROM shortlinks WHERE file_path = ? OR substr(file_path, 1, ?) = ?')
              .bind(oldPath, oldPrefix.length, oldPrefix).run();
            await env.harudrive_db.prepare(
              'INSERT OR REPLACE INTO shortlinks (short_id, file_path, name, type, size) VALUES (?, ?, ?, ?, ?)'
            ).bind(newShortId, newPath, newName, isDirectory ? 'folder' : 'file', 0).run();
          } catch (e) {}
        }

        return new Response(JSON.stringify({ success: true, oldPath, newPath }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // API: Move (Atomic NDJSON Protocol)
    if (url.pathname === '/api/admin/move' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (body.admin_pin !== ADMIN_PIN) {
          return new Response(JSON.stringify({ error: 'PIN Admin Salah!' }), { status: 403 });
        }

        const paths = body.paths || (body.path ? [body.path] : []);
        const targetFolder = (body.target_folder || '').replace(/^\/+|\/+$/g, '');
        if (!paths.length) {
          return new Response(JSON.stringify({ error: 'Tidak ada file/folder yang dipilih.' }), { status: 400 });
        }

        const treeRes = await fetch(`https://huggingface.co/api/datasets/${HF_REPO_ID}/tree/main?recursive=true`, {
          headers: { 'Authorization': `Bearer ${HF_TOKEN}` }
        });
        const treeItems = treeRes.ok ? await treeRes.json() : [];

        const lines = [
          JSON.stringify({ key: 'header', value: { summary: `Move ${paths.length} item(s) to /${targetFolder} via HaruDrive`, description: '' } })
        ];

        let opsCount = 0;
        for (const p of paths) {
          const cleanP = p.replace(/^\/+|\/+$/g, '');
          const filename = cleanP.split('/').pop();

          let matchedFiles = 0;
          treeItems.forEach(item => {
            if (item.type === 'file') {
              if (item.path === cleanP) {
                matchedFiles++;
                const newPath = targetFolder ? `${targetFolder}/${filename}` : filename;
                if (cleanP !== newPath) {
                  opsCount++;
                  lines.push(JSON.stringify({ key: 'deletedFile', value: { path: cleanP } }));
                  if (item.lfs && item.lfs.oid) {
                    lines.push(JSON.stringify({ key: 'lfsFile', value: { path: newPath, algo: 'sha256', oid: item.lfs.oid, size: item.lfs.size || item.size } }));
                  } else {
                    lines.push(JSON.stringify({ key: 'file', value: { path: newPath, content: '', encoding: 'utf-8' } }));
                  }
                }
              } else if (item.path.startsWith(cleanP + '/')) {
                matchedFiles++;
                const relPath = item.path.substring(cleanP.length + 1);
                const newPath = targetFolder ? `${targetFolder}/${filename}/${relPath}` : `${filename}/${relPath}`;
                opsCount++;
                lines.push(JSON.stringify({ key: 'deletedFile', value: { path: item.path } }));
                if (item.lfs && item.lfs.oid) {
                  lines.push(JSON.stringify({ key: 'lfsFile', value: { path: newPath, algo: 'sha256', oid: item.lfs.oid, size: item.lfs.size || item.size } }));
                } else {
                  lines.push(JSON.stringify({ key: 'file', value: { path: newPath, content: '', encoding: 'utf-8' } }));
                }
              }
            }
          });

          if (matchedFiles === 0) {
            const newPath = targetFolder ? `${targetFolder}/${filename}` : filename;
            if (cleanP !== newPath) {
              opsCount++;
              lines.push(JSON.stringify({ key: 'deletedFolder', value: { path: cleanP } }));
              lines.push(JSON.stringify({ key: 'file', value: { path: `${newPath}/.gitkeep`, content: '', encoding: 'utf-8' } }));
            }
          }
        }

        if (opsCount > 0) {
          const commitUrl = `https://huggingface.co/api/datasets/${HF_REPO_ID}/commit/main`;
          const ndjsonBody = lines.join(String.fromCharCode(10)) + String.fromCharCode(10);

          const hfRes = await fetch(commitUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${HF_TOKEN}`,
              'Content-Type': 'application/x-ndjson'
            },
            body: ndjsonBody
          });

          if (!hfRes.ok) {
            const errText = await hfRes.text();
            return new Response(JSON.stringify({ error: `Gagal memindahkan di HF: ${errText}` }), { status: hfRes.status });
          }

          if (env.harudrive_db) {
            for (const p of paths) {
              const cleanP = p.replace(/^\/+|\/+$/g, '');
              const filename = cleanP.split('/').pop();
              const newPath = targetFolder ? `${targetFolder}/${filename}` : filename;
              const newShortId = await generateShortId(newPath);
              const cleanPrefix = cleanP + '/';
              try {
                await env.harudrive_db.prepare('DELETE FROM shortlinks WHERE file_path = ? OR substr(file_path, 1, ?) = ?')
                  .bind(cleanP, cleanPrefix.length, cleanPrefix).run();
                await env.harudrive_db.prepare(
                  'INSERT OR REPLACE INTO shortlinks (short_id, file_path, name, type, size) VALUES (?, ?, ?, ?, ?)'
                ).bind(newShortId, newPath, filename, 'file', 0).run();
              } catch (e) {}
            }
          }
        }

        return new Response(JSON.stringify({ success: true, movedCount: paths.length }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // API: Delete (Guaranteed Full Deletion of Files & Folders via NDJSON Protocol)
    if (url.pathname === '/api/admin/delete' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (body.admin_pin !== ADMIN_PIN) {
          return new Response(JSON.stringify({ error: 'PIN Admin Salah!' }), { status: 403 });
        }

        const paths = body.paths || (body.path ? [body.path] : []);
        if (!paths.length) {
          return new Response(JSON.stringify({ error: 'Tidak ada item yang dipilih untuk dihapus.' }), { status: 400 });
        }

        // Fetch repo tree to identify directory vs file
        const treeRes = await fetch(`https://huggingface.co/api/datasets/${HF_REPO_ID}/tree/main?recursive=true`, {
          headers: { 'Authorization': `Bearer ${HF_TOKEN}` }
        });
        const treeItems = treeRes.ok ? await treeRes.json() : [];

        const lines = [
          JSON.stringify({ key: 'header', value: { summary: `Delete ${paths.length} item(s) via HaruDrive`, description: '' } })
        ];

        const deletedSet = new Set();
        for (const p of paths) {
          const cleanP = p.replace(/^\/+|\/+$/g, '');
          if (!cleanP) continue;

          // Check if it's a directory in treeItems
          const isDirInTree = treeItems.some(it => it.path === cleanP && it.type === 'directory');
          const hasChildrenInTree = treeItems.some(it => it.path.startsWith(cleanP + '/'));
          const isDir = isDirInTree || hasChildrenInTree;

          if (isDir) {
            if (!deletedSet.has('dir:' + cleanP)) {
              deletedSet.add('dir:' + cleanP);
              lines.push(JSON.stringify({ key: 'deletedFolder', value: { path: cleanP } }));
            }
          } else {
            if (!deletedSet.has('file:' + cleanP)) {
              deletedSet.add('file:' + cleanP);
              lines.push(JSON.stringify({ key: 'deletedFile', value: { path: cleanP } }));
            }
          }
        }

        const commitUrl = `https://huggingface.co/api/datasets/${HF_REPO_ID}/commit/main`;
        const ndjsonBody = lines.join(String.fromCharCode(10)) + String.fromCharCode(10);

        const hfRes = await fetch(commitUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${HF_TOKEN}`,
            'Content-Type': 'application/x-ndjson'
          },
          body: ndjsonBody
        });

        if (!hfRes.ok) {
          const errText = await hfRes.text();
          console.error('HF Commit delete error:', errText);
          return new Response(JSON.stringify({ error: `Gagal commit delete ke HF: ${errText}` }), { status: hfRes.status });
        }

        // Clean D1 database with substr
        if (env.harudrive_db) {
          for (const p of paths) {
            const cleanP = p.replace(/^\/+|\/+$/g, '');
            const prefix = cleanP + '/';
            try {
              await env.harudrive_db.prepare('DELETE FROM shortlinks WHERE file_path = ? OR substr(file_path, 1, ?) = ?')
                .bind(cleanP, prefix.length, prefix).run();
            } catch (d1Err) {
              console.error('D1 delete warning:', d1Err);
            }
          }
        }

        return new Response(JSON.stringify({ success: true, deletedCount: paths.length }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // Direct / Stream / Download Routes
    if (url.pathname.startsWith('/file/') || url.pathname.startsWith('/d/') || url.pathname.startsWith('/raw/')) {
      const isDownload = url.pathname.startsWith('/d/') || url.searchParams.get('download') === '1';
      let pathAfterPrefix = url.pathname.replace(/^\/(file|d|raw)\//, '');
      const shortId = pathAfterPrefix.split('/')[0];

      // Resolve shortId -> real Drive ID if this is a GDrive shortId (stored as file_path = Drive ID)
      let realShortId = shortId;
      let gDriveFileId = null;
      // Check if this shortId maps to a Drive ID in D1 (GDrive)
      if (env.harudrive_db) {
        try {
          const r2 = await env.harudrive_db.prepare('SELECT file_path FROM shortlinks WHERE short_id = ?').bind(shortId).first();
          if (r2 && r2.file_path && r2.file_path.length > 20 && r2.file_path.indexOf('/') === -1) {
            // file_path looks like a Drive ID (no slash, long)
            gDriveFileId = r2.file_path;
          }
        } catch(e) {}
      }
      const gMode2 = url.searchParams.get('mode') || request.headers.get('X-Storage-Mode') || '';
      const isLikelyGDriveId = shortId.length > 20 || !!gDriveFileId;
      const effectiveGDriveId = gDriveFileId || shortId;
      if (gMode2 === 'gdrive' || isLikelyGDriveId) {
        const gToken = await getGDriveAccessToken(env);
        if (!gToken) return new Response('GDrive not configured', { status: 500 });
        const gDriveUrl = `https://www.googleapis.com/drive/v3/files/${effectiveGDriveId}?alt=media&supportsAllDrives=true`;
        const gHeaders = new Headers();
        gHeaders.set('Authorization', `Bearer ${gToken}`);
        const gRange = request.headers.get('Range');
        if (gRange) gHeaders.set('Range', gRange);
        const gRes = await fetch(gDriveUrl, { headers: gHeaders });
        if (!gRes.ok && gRes.status !== 206) return new Response(`Drive File Not Found (${gRes.status})`, { status: gRes.status });
        const gRespHeaders = new Headers(gRes.headers);
        gRespHeaders.set('Access-Control-Allow-Origin', '*');
        let gFileName = effectiveGDriveId;
        try {
          const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${effectiveGDriveId}?fields=name,size&supportsAllDrives=true`, { headers: { 'Authorization': `Bearer ${gToken}` } });
          if (metaRes.ok) { const meta = await metaRes.json(); if (meta.name) gFileName = meta.name; 
            // Track bandwidth for GDrive (best-effort)
            try { const sz = parseInt(meta.size || '0', 10); if (sz > 0 && env.harudrive_db) { await env.harudrive_db.prepare('INSERT INTO bandwidth_stats (mode, bytes, requests, updated) VALUES (?, ?, 1, ?) ON CONFLICT(mode) DO UPDATE SET bytes = bytes + ?, requests = requests + 1, updated = ?').bind('gdrive', sz, Date.now(), sz, Date.now()).run().catch(()=>{}); } } catch(e) {}
          }
        } catch(e) {}
        const gSafeName = encodeURIComponent(gFileName);
        const gDisp = isDownload ? 'attachment' : 'inline';
        gRespHeaders.set('Content-Disposition', `${gDisp}; filename="${gFileName.replace(/"/g, '')}"; filename*=UTF-8''${gSafeName}`);
        if (!gRespHeaders.get('Content-Type')) gRespHeaders.set('Content-Type', getMimeType(gFileName));
        return new Response(gRes.body, { status: gRes.status, headers: gRespHeaders });
      }
      let filePath = '';
      let fileName = '';

      if (env.harudrive_db) {
        const row = await env.harudrive_db.prepare('SELECT file_path, name FROM shortlinks WHERE short_id = ?').bind(shortId).first();
        if (row && row.file_path) {
          filePath = row.file_path;
          fileName = row.name;
        }
      }

      if (!filePath) {
        filePath = decodeURIComponent(pathAfterPrefix);
        fileName = filePath.split('/').pop() || 'file';
      }

      const hfFileUrl = `https://huggingface.co/datasets/${HF_REPO_ID}/resolve/main/${encodeURI(filePath)}`;
      const hfHeaders = new Headers();
      if (HF_TOKEN) hfHeaders.set('Authorization', `Bearer ${HF_TOKEN}`);

      const range = request.headers.get('Range');
      if (range) hfHeaders.set('Range', range);

      const hfRes = await fetch(hfFileUrl, { headers: hfHeaders });
      if (!hfRes.ok && hfRes.status !== 206) {
        return new Response(`File Not Found on Storage (${hfRes.status})`, { status: hfRes.status });
      }

      // Track bandwidth for HF (best-effort, ignore if D1 limit hit)
      try { const cLen = parseInt(hfRes.headers.get('Content-Length') || '0', 10) || parseInt(hfRes.headers.get('Content-Range')?.split('/')?.pop() || '0', 10) || 0; if (cLen > 0 && env.harudrive_db) { await env.harudrive_db.prepare('INSERT INTO bandwidth_stats (mode, bytes, requests, updated) VALUES (?, ?, 1, ?) ON CONFLICT(mode) DO UPDATE SET bytes = bytes + ?, requests = requests + 1, updated = ?').bind('hf', cLen, Date.now(), cLen, Date.now()).run().catch(()=>{}); } } catch(e) {}
      const respHeaders = new Headers(hfRes.headers);
      const mime = getMimeType(fileName);
      respHeaders.set('Content-Type', mime);
      respHeaders.set('Access-Control-Allow-Origin', '*');

      const safeFileName = encodeURIComponent(fileName);
      const disposition = isDownload ? 'attachment' : 'inline';
      respHeaders.set('Content-Disposition', `${disposition}; filename="${fileName.replace(/"/g, '')}"; filename*=UTF-8''${safeFileName}`);

      return new Response(hfRes.body, {
        status: hfRes.status,
        headers: respHeaders
      });
    }

    // Page Routes
    if (url.pathname === '/admin') {
      return new Response(htmlPage(adminConsoleUI(), env, 'admin'), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // Public page: logged-in users get the full-width file-manager view,
    // guests hitting a shared link get the centered folder card.
    const publicView = isLoggedIn ? publicIndexUI() : publicUI();
    return new Response(htmlPage(publicView, env, 'public'), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
};

async function syncIndex(env) {
  if (!env.harudrive_db) return { items: 0, truncated: false };
  const repoId = env.HF_REPO_ID || 'username/harudrive-data';
  const token = env.HF_TOKEN || '';
  const hfHeaders = { 'User-Agent': 'HaruDrive/1.0' };
  if (token) hfHeaders['Authorization'] = `Bearer ${token}`;

  let items = 0;
  const MAX_ITEMS = 4000;
  const seen = new Set();
  const dirStats = new Map();
  let nextUrl = `https://huggingface.co/api/datasets/${repoId}/tree/main?recursive=true`;

  while (nextUrl && items < MAX_ITEMS) {
    const hfRes = await fetch(nextUrl, { headers: hfHeaders });
    if (!hfRes.ok) {
      const errText = await hfRes.text();
      throw new Error(`Hugging Face error (${hfRes.status}): ${errText}`);
    }
    const pageItems = await hfRes.json();
    if (!Array.isArray(pageItems)) break;

    for (const item of pageItems) {
      const path = item.path;
      if (!path || path.startsWith('.') || path === 'README.md' || item.type === 'directory') continue;
      if (seen.has(path)) continue;
      seen.add(path);

      const shortId = await generateShortId(path);
      const filename = path.split('/').pop();
      const fileSize = item.size || 0;
      await env.harudrive_db.prepare(
        'INSERT OR REPLACE INTO shortlinks (short_id, file_path, name, type, size) VALUES (?, ?, ?, ?, ?)'
      ).bind(shortId, path, filename, 'file', fileSize).run();
      items++;
      if (items >= MAX_ITEMS) break;

      // Accumulate recursive size / file count per ancestor folder.
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        const st = dirStats.get(dir) || { size: 0, files: 0 };
        st.size += fileSize;
        st.files += 1;
        dirStats.set(dir, st);
      }
    }

    const linkHeader = hfRes.headers.get('Link') || '';
    const m = linkHeader.match(/<([^>]+)>\s*;\s*rel="next"/);
    nextUrl = m ? (m[1].startsWith('http') ? m[1] : 'https://huggingface.co' + m[1]) : '';
  }

  if (dirStats.size > 0) {
    await env.harudrive_db.prepare('CREATE TABLE IF NOT EXISTS folder_sizes (path TEXT PRIMARY KEY, size INTEGER, files INTEGER)').run();
    const upsert = env.harudrive_db.prepare('INSERT OR REPLACE INTO folder_sizes (path, size, files) VALUES (?, ?, ?)');
    for (const [dir, st] of dirStats) {
      await upsert.bind(dir, st.size, st.files).run();
    }
  }
  return { items, truncated: items >= MAX_ITEMS };
}

async function recordLastSync(env) {
  try {
    await env.harudrive_db.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)').run();
    await env.harudrive_db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)").bind(String(Date.now())).run();
  } catch (e) {}
}

async function maybeAutoSync(env) {
  try {
    if (!env.harudrive_db) return;
    const now = Date.now();
    await env.harudrive_db.prepare('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)').run();
    // Serialize: only one background sync at a time (prevents D1 write contention).
    const lockRow = await env.harudrive_db.prepare("SELECT value FROM meta WHERE key = 'sync_lock'").first();
    if (lockRow && (now - parseInt(lockRow.value || '0', 10) < 2 * 60 * 1000)) return;
    const lastRow = await env.harudrive_db.prepare("SELECT value FROM meta WHERE key = 'last_sync'").first();
    if (lastRow && (now - parseInt(lastRow.value || '0', 10) < 55 * 60 * 1000)) return;
    await env.harudrive_db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('sync_lock', ?)").bind(String(now)).run();
    try {
      await syncIndex(env);
      await env.harudrive_db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)").bind(String(Date.now())).run();
    } finally {
      await env.harudrive_db.prepare("DELETE FROM meta WHERE key = 'sync_lock'").run();
    }
  } catch (e) {}
}

async function generateShortId(path) {
  const encoder = new TextEncoder();
  const data = encoder.encode(path);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const base64 = btoa(String.fromCharCode.apply(null, hashArray))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return base64.substring(0, 8);
}

function getMimeType(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const mimeTypes = {
    'mkv': 'video/x-matroska',
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'avi': 'video/x-msvideo',
    'mov': 'video/quicktime',
    'flv': 'video/x-flv',
    'wmv': 'video/x-ms-wmv',
    'ts': 'video/mp2t',
    'mp3': 'audio/mpeg',
    'flac': 'audio/flac',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'm4a': 'audio/mp4',
    'zip': 'application/zip',
    'rar': 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    'tar': 'application/x-tar',
    'gz': 'application/gzip',
    'pdf': 'application/pdf',
    'txt': 'text/plain',
    'srt': 'text/plain',
    'vtt': 'text/vtt',
    'ass': 'text/plain',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml'
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

async function getGDriveAccessToken(env) {
  const cid = env.GDRIVE_CLIENT_ID || '';
  const csec = env.GDRIVE_CLIENT_SECRET || '';
  const rtoken = env.GDRIVE_REFRESH_TOKEN || '';
  if (!cid || !csec || !rtoken) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${encodeURIComponent(cid)}&client_secret=${encodeURIComponent(csec)}&refresh_token=${encodeURIComponent(rtoken)}&grant_type=refresh_token`
  });
  if (!res.ok) return null;
  const j = await res.json().catch(() => ({}));
  return j.access_token || null;
}
async function listGDriveFolder(folderId, env) {
  const token = await getGDriveAccessToken(env);
  if (!token) throw new Error('GDrive not configured - set GDRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN');
  const q = `'${folderId}' in parents and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=folder,name`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.files || []).map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: parseInt(f.size || '0', 10), modifiedTime: f.modifiedTime, isFolder: f.mimeType === 'application/vnd.google-apps.folder' }));
}
async function searchGDrive(query, env) {
  const token = await getGDriveAccessToken(env);
  if (!token) throw new Error('GDrive not configured');
  const safeQ = query.replace(/'/g, "\\'");
  const q = `name contains '${safeQ}' and trashed = false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size,modifiedTime,parents)&pageSize=60&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive API ${res.status}`);
  const data = await res.json();
  return (data.files || []).map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: parseInt(f.size || '0', 10), modifiedTime: f.modifiedTime }));
}

function htmlPage(content, env, pageMode = 'public') {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>HaruDrive</title>
  
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22%23ec4899%22><path d=%22M12 2a4 4 0 0 0-3.5 6 4 4 0 0 0-6 3.5 4 4 0 0 0 3.5 6 4 4 0 0 0 6 3.5 4 4 0 0 0 6-3.5 4 4 0 0 0 3.5-6 4 4 0 0 0-3.5-6 4 4 0 0 0-6-3.5z%22/><circle cx=%2212%22 cy=%2212%22 r=%222.5%22 fill=%22%23ffffff%22/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  
  <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>

  <style>
    :root {
      --primary: #6366f1;
      --primary-light: #818cf8;
      --accent: #ec4899;
      --accent-gradient: linear-gradient(135deg, #ec4899 0%, #a855f7 50%, #6366f1 100%);
      --bg: #090d16;
      --bg-surface: rgba(17, 24, 39, 0.82);
      --bg-card: rgba(22, 30, 49, 0.92);
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
      --bg: #f4f6fb;
      --bg-surface: rgba(255, 255, 255, 0.94);
      --bg-card: #ffffff;
      --border: #e2e8f0;
      --border-focus: #ec4899;
      --text: #0f172a;
      --text-muted: #475569;
      --text-dim: #64748b;
      --hover-row: rgba(99, 102, 241, 0.06);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scrollbar-gutter: stable; }
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
      transition: background 0.25s, color 0.25s;
    }

    body.modal-open { overflow: hidden !important; }
    .glass {
      background: var(--bg-surface);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border);
    }

    .icon {
      width: 17px;
      height: 17px;
      stroke-width: 2;
      stroke: currentColor;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      flex-shrink: 0;
    }
    .icon-sm { width: 14px; height: 14px; }
    .icon-lg { width: 22px; height: 22px; }

    .sakura-icon-svg {
      width: 22px;
      height: 22px;
      display: block;
      overflow: visible;
      fill: #ec4899;
      filter: drop-shadow(0 0 6px rgba(236, 72, 153, 0.6));
      flex-shrink: 0;
    }

    .navbar-cyber {
      position: sticky;
      top: 0;
      z-index: 100;
      border-bottom: 1px solid var(--border);
      box-shadow: 0 4px 25px rgba(0, 0, 0, 0.15);
    }
    .nav-container {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 24px;
      gap: 16px;
      max-width: 1300px;
      margin: 0 auto;
    }
    .nav-left, .nav-right {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .nav-center {
      flex: 1;
      max-width: 480px;
      display: flex;
      justify-content: center;
    }

    .brand-logo {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      user-select: none;
      cursor: pointer;
      overflow: visible;
      flex-shrink: 0;
    }
    .logo-glow-wrap {
      width: 38px;
      height: 38px;
      overflow: visible;
      flex-shrink: 0;
      border-radius: 12px;
      background: rgba(236, 72, 153, 0.15);
      border: 1px solid rgba(236, 72, 153, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 16px rgba(236, 72, 153, 0.3);
      transition: transform 0.25s, box-shadow 0.25s;
    }
    .brand-logo:hover .logo-glow-wrap {
      transform: scale(1.08) rotate(12deg);
      box-shadow: 0 0 22px rgba(236, 72, 153, 0.5);
    }
    .brand-info { display: flex; flex-direction: column; }
    .brand-title {
      font-size: 1.25rem;
      font-weight: 800;
      background: var(--accent-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      letter-spacing: -0.5px;
      line-height: 1.1;
    }
    .brand-subtag {
      font-size: 0.65rem;
      font-weight: 700;
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
    .status-text { font-size: 0.72rem; font-weight: 700; color: #10b981; }

    .spotlight-search {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 14px;
      border-radius: 24px;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid var(--border);
      transition: all 0.2s;
    }
    body.light .spotlight-search { background: #f1f5f9; border-color: #cbd5e1; }
    .spotlight-search:focus-within {
      border-color: var(--accent);
      background: var(--bg-card);
      box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.2);
    }
    .spotlight-icon { color: var(--text-dim); }
    .spotlight-search input {
      background: transparent;
      border: none;
      outline: none;
      color: var(--text);
      font-family: inherit;
      font-size: 0.88rem;
      width: 100%;
    }
    body.light .spotlight-search input { color: #0f172a; }
    .shortcut-badge {
      font-size: 0.65rem;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 6px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid var(--border);
      color: var(--text-dim);
      white-space: nowrap;
      user-select: none;
    }
    body.light .shortcut-badge { background: #e2e8f0; color: #475569; }

    .nav-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 7px 12px;
      border-radius: 20px;
      color: var(--text);
      text-decoration: none;
      font-size: 0.84rem;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border);
      background: var(--bg-card);
      transition: all 0.2s;
      flex-shrink: 0;
    }
    .nav-btn:hover {
      border-color: var(--primary-light);
      background: rgba(99, 102, 241, 0.12);
      transform: translateY(-1px);
    }
    .btn-admin-nav {
      background: rgba(99, 102, 241, 0.12);
      border-color: rgba(99, 102, 241, 0.3);
      color: var(--primary-light);
    }

    .filter-strip {
      padding: 8px 24px;
      background: rgba(11, 15, 25, 0.35);
      border-top: 1px solid var(--border);
      overflow-x: auto;
      scrollbar-width: none;
    }
    .filter-strip::-webkit-scrollbar { display: none; }
    body.light .filter-strip { background: #f1f5f9; }
    .filter-container {
      display: flex;
      align-items: center;
      gap: 8px;
      max-width: 1300px;
      margin: 0 auto;
    }
    .filter-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 12px;
      border-radius: 20px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text-muted);
      font-size: 0.78rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s;
    }
    .filter-chip:hover { color: var(--text); border-color: var(--primary-light); }
    .filter-chip.active {
      background: var(--accent-gradient);
      color: #fff;
      border-color: transparent;
      box-shadow: 0 2px 10px rgba(236, 72, 153, 0.3);
    }

    .container {
      max-width: 1300px;
      width: 100%;
      margin: 18px auto;
      padding: 0 20px;
      flex: 1;
    }

    /* BREADCRUMB & TOP ACTIONS BAR */
    .breadcrumb-bar {
      padding: 10px 16px;
      border-radius: var(--radius);
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      min-width: 0;
      overflow: hidden;
    }
    .crumb-group {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.88rem;
      font-weight: 600;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
      -ms-overflow-style: none;
    }
    .crumb-group::-webkit-scrollbar { display: none; }
    .crumb {
      color: var(--primary-light);
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 260px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex-shrink: 1;
      min-width: 0;
    }
    .crumb.active {
      max-width: 520px;
    }
    .crumb:hover { text-decoration: underline; }
    .crumb-sep { color: var(--text-dim); }
    .crumb-current { color: var(--text); font-weight: 700; }
    
    .toolbar-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .search-box {
      position: relative;
      flex: 1 1 0;
      min-width: 140px;
      max-width: 360px;
    }
    .search-clear-btn:hover { background: rgba(236,72,153,0.15); border-color: rgba(236,72,153,0.4); color: #ec4899; }
    
    .btn-action-tool {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 7px 13px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text);
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.2s;
    }
    .btn-action-tool:hover {
      border-color: var(--primary-light);
      background: rgba(99, 102, 241, 0.12);
      transform: translateY(-1px);
    }

    .folder-stats-label {
      font-size: 0.8rem;
      color: var(--text-dim);
      font-weight: 600;
      padding: 0 2px 10px;
      letter-spacing: 0.02em;
    }
    .file-table-wrapper {
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
    }
    body.light .file-table-wrapper { box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05); }
    
    .table-header {
      display: flex;
      align-items: center;
      padding: 12px 18px;
      font-size: 0.76rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      border-bottom: 1px solid var(--border);
      user-select: none;
      background: rgba(0, 0, 0, 0.05);
    }
    .col-cb { width: 34px; display: flex; align-items: center; flex-shrink: 0; }
    .col-name { flex: 1; min-width: 0; }
    .col-size { width: 100px; text-align: right; flex-shrink: 0; }
    .col-date { width: 150px; text-align: right; flex-shrink: 0; }
    .col-actions { width: 110px; text-align: right; flex-shrink: 0; }
    body[data-mode="admin"] .col-actions { width: 170px; }
    .gdi-sort-header { cursor: pointer; user-select: none; position: relative; }
    .gdi-sort-header:hover { color: var(--text); }
    .gdi-sort-header::after { content: '↕'; margin-left: 6px; opacity: 0.35; font-size: 0.7em; vertical-align: middle; }
    .gdi-sort-header.asc::after { content: '▲'; opacity: 1; color: var(--primary-light); }
    .gdi-sort-header.desc::after { content: '▼'; opacity: 1; color: var(--primary-light); }

    .file-row {
      display: flex;
      align-items: center;
      padding: 10px 18px;
      border-bottom: 1px solid var(--border);
      transition: background 0.15s;
    }
    .file-row:hover { background: var(--hover-row); }
    .file-row:last-child { border-bottom: none; }

    .file-name-cell {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      cursor: pointer;
      min-width: 0;
      overflow: hidden;
    }
    
    .file-icon-box {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .file-icon-box.folder {
      background: rgba(245, 158, 11, 0.15);
      border: 1px solid rgba(245, 158, 11, 0.3);
    }
    .file-icon-box.video {
      background: rgba(236, 72, 153, 0.15);
      border: 1px solid rgba(236, 72, 153, 0.3);
    }
    .file-icon-box.archive {
      background: rgba(168, 85, 247, 0.15);
      border: 1px solid rgba(168, 85, 247, 0.3);
    }
    .file-icon-box.file {
      background: rgba(99, 102, 241, 0.15);
      border: 1px solid rgba(99, 102, 241, 0.3);
    }

    .file-title {
      font-size: 0.88rem;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .file-row.is-folder .file-title { color: #f59e0b; }

    .file-size-cell, .file-date-cell {
      font-size: 0.8rem;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
      flex-shrink: 0;
    }
    .file-size-cell { width: 100px; text-align: right; }
    .file-date-cell { width: 150px; text-align: right; }

    .file-actions-cell {
      width: 110px;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }
    body[data-mode="admin"] .file-actions-cell {
      width: 170px;
    }
    .btn-act {
      width: 30px;
      height: 30px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text);
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
      flex-shrink: 0;
    }
    .btn-act:hover {
      border-color: var(--primary-light);
      background: var(--primary);
      color: white;
    }
    .btn-act.btn-delete { color: #ef4444; border-color: rgba(239, 68, 68, 0.25); }
    .btn-act.btn-delete:hover { background: #ef4444; color: white; }

    /* ==========================================================
       FLOATING BULK TOOLBAR (ULTRA COMPACT & NO OVERFLOW)
       ========================================================== */
    .bulk-toolbar {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 30px;
      box-shadow: 0 14px 45px rgba(0, 0, 0, 0.65);
      z-index: 1000;
      background: var(--bg-card);
      border: 1px solid rgba(236, 72, 153, 0.4);
      max-width: 95vw;
      box-sizing: border-box;
      animation: toolbarSlideUp 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    @keyframes toolbarSlideUp {
      0% { opacity: 0; transform: translate(-50%, 25px); }
      100% { opacity: 1; transform: translate(-50%, 0); }
    }
    
    .bulk-count-badge {
      font-size: 0.8rem;
      font-weight: 700;
      color: var(--text);
      white-space: nowrap;
      flex-shrink: 0;
      padding-right: 4px;
    }

    .btn-bulk {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 6px 10px;
      border-radius: 18px;
      border: 1px solid var(--border);
      font-weight: 600;
      font-size: 0.78rem;
      cursor: pointer;
      background: var(--bg-surface);
      color: var(--text);
      white-space: nowrap;
      transition: all 0.2s;
      flex-shrink: 0;
    }
    .btn-bulk:hover {
      border-color: var(--primary-light);
      background: rgba(99, 102, 241, 0.15);
    }
    .btn-bulk.danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.4);
      color: #ef4444;
    }
    .btn-bulk.danger:hover { background: #ef4444; color: white; }

    .btn-bulk-close {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: all 0.2s;
    }
    .btn-bulk-close:hover {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
      border-color: rgba(239, 68, 68, 0.4);
    }

    /* MODALS */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(5, 8, 16, 0.85);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      z-index: 2000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal-card {
      width: 100%;
      max-width: 520px;
      border-radius: 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6);
      overflow: hidden;
      animation: modalPop 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes modalPop {
      0% { opacity: 0; transform: scale(0.96) translateY(10px); }
      100% { opacity: 1; transform: scale(1) translateY(0); }
    }
    
    .video-card {
      max-width: 760px;
      width: 100%;
      border-radius: 18px;
      display: flex;
      flex-direction: column;
    }
    .video-container-wrap {
      width: 100%;
      background: #000;
      overflow: hidden;
      aspect-ratio: 16 / 9;
      max-height: 55vh;
    }
    .plyr--video { height: 100%; width: 100%; }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
    }
    .modal-title {
      font-size: 0.95rem;
      font-weight: 700;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 85%;
    }
    .btn-close-circle {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .btn-close-circle:hover {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.4);
      color: #ef4444;
    }

    .modal-body {
      padding: 16px 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .modal-footer {
      padding: 12px 18px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }

    .form-input-pro {
      width: 100%;
      padding: 10px 14px;
      border-radius: 12px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text);
      font-family: inherit;
      font-size: 0.9rem;
      outline: none;
      transition: all 0.2s;
    }
    .form-input-pro:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(236, 72, 153, 0.2);
    }

    .pin-input-stealth {
      -webkit-text-security: disc;
      -moz-text-security: disc;
      letter-spacing: 6px;
      font-size: 1.3rem !important;
      font-weight: 700;
      text-align: center;
    }

    .folder-tree-box {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(11, 15, 25, 0.5);
      max-height: 180px;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    body.light .folder-tree-box { background: #f8fafc; }
    .folder-tree-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.86rem;
      font-weight: 600;
      color: var(--text-muted);
      transition: all 0.15s;
    }
    .folder-tree-item:hover {
      background: rgba(99, 102, 241, 0.1);
      color: var(--text);
    }
    .picker-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.86rem;
      font-weight: 600;
      color: var(--text-muted);
      transition: all 0.15s;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
      flex-shrink: 0;
    }
    .picker-item:hover { background: rgba(99, 102, 241, 0.1); color: var(--text); }
    .picker-item.active { background: rgba(236, 72, 153, 0.15); border: 1px solid rgba(236, 72, 153, 0.4); color: #ec4899; font-weight: 700; }
    .folder-tree-item.selected {
      background: rgba(236, 72, 153, 0.15);
      border: 1px solid rgba(236, 72, 153, 0.4);
      color: #ec4899;
      font-weight: 700;
    }

    .external-players-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .btn-ext-player {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 5px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-surface);
      color: var(--text);
      font-size: 0.76rem;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.2s;
    }
    .btn-ext-player:hover {
      border-color: var(--primary-light);
      background: rgba(99, 102, 241, 0.12);
    }

    .dropzone-box {
      border: 2px dashed rgba(236, 72, 153, 0.4);
      background: rgba(236, 72, 153, 0.04);
      border-radius: 14px;
      padding: 24px;
      text-align: center;
      cursor: pointer;
      transition: all 0.2s;
    }
    .dropzone-box:hover {
      border-color: var(--accent);
      background: rgba(236, 72, 153, 0.08);
    }

    /* RESPONSIVE MOBILE */
    @media (max-width: 768px) {
      .nav-container { flex-wrap: wrap; padding: 10px 14px; gap: 8px; }
      .nav-left { gap: 8px; }
      .nav-right { gap: 6px; }
      .nav-center { order: 3; max-width: 100%; width: 100%; flex: none; }
      .status-capsule { display: none; }
      .brand-title { font-size: 1.1rem; }
      .brand-subtag { display: none; }
      .btn-text-label { display: none; }
      .nav-btn { padding: 7px 9px; }
      .filter-strip { padding: 6px 12px; }
      .container { padding: 0 10px; margin: 10px auto; }
      
      .breadcrumb-bar {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
        padding: 12px 14px;
      }
      .toolbar-actions {
        display: flex;
        flex-wrap: nowrap;
        gap: 8px;
        width: 100%;
        align-items: center;
      }
      .search-box {
        flex: 1 1 0;
        min-width: 0;
        max-width: none;
      }
      .btn-action-tool {
        padding: 8px 10px;
        font-size: 0.78rem;
        flex-shrink: 0;
        white-space: nowrap;
      }

      .col-date, .file-date-cell { display: none; }
      .col-size, .file-size-cell { display: none; }
      .guest-table-header { grid-template-columns: 40px 1fr 110px; }
      .guest-file-list .file-row { grid-template-columns: 40px 1fr 110px; }
      
      .table-header { padding: 10px 12px; }
      .file-row { padding: 10px 12px; }
      .col-cb { width: 28px; }
      
      .col-actions { width: 75px; }
      .file-actions-cell { width: 75px; gap: 4px; }
      body[data-mode="admin"] .col-actions { width: 105px; }
      body[data-mode="admin"] .file-actions-cell { width: 105px; gap: 3px; }

      .btn-act { width: 24px; height: 24px; }
      body[data-mode="admin"] .col-actions { width: 120px; }
      body[data-mode="admin"] .file-actions-cell { width: 120px; gap: 2px; }
      .file-title { font-size: 0.84rem; }

      /* Mobile Bulk Toolbar - Ultra Compact Fitting */
      .bulk-toolbar {
        width: calc(100% - 16px);
        max-width: 100%;
        padding: 6px 8px;
        gap: 4px;
        bottom: 12px;
      }
      .bulk-count-badge { font-size: 0.74rem; padding-right: 2px; }
      .btn-bulk {
        padding: 5px 6px;
        font-size: 0.72rem;
        gap: 3px;
        flex: 1;
        justify-content: center;
      }
      .btn-bulk svg { width: 12px; height: 12px; }
      .btn-bulk-close { width: 24px; height: 24px; }
      
      .modal-backdrop { padding: 12px; align-items: center; }
      .modal-card { max-width: 100%; border-radius: 18px; }
    }
  
/* === GUEST FOCUSED CARD UI (Screenshot 2 Style) === */
.guest-card-container {
  max-width: 720px;
  margin: 30px auto 40px;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 28px 24px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(16px);
  position: relative;
}

.guest-folder-header {
  text-align: center;
  margin-bottom: 24px;
}

.guest-big-icon-wrap {
  width: 64px;
  height: 64px;
  margin: 0 auto 14px;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #f59e0b;
  box-shadow: 0 8px 24px rgba(245, 158, 11, 0.15);
}

.guest-big-icon-wrap svg {
  width: 32px;
  height: 32px;
}

.guest-folder-title {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--text);
  line-height: 1.4;
  margin: 0 0 6px;
  word-break: break-word;
}

.guest-folder-meta {
  font-size: 0.82rem;
  color: var(--text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.guest-bulk-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 20px;
}

.btn-download-selected {
  width: 100%;
  padding: 13px 20px;
  background: #10b981;
  color: #ffffff;
  border: none;
  border-radius: 12px;
  font-size: 0.92rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: all 0.2s ease;
  box-shadow: 0 4px 14px rgba(16, 185, 129, 0.3);
}

.btn-download-selected:hover {
  background: #059669;
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(16, 185, 129, 0.4);
}

.btn-copy-links {
  width: 100%;
  padding: 11px 20px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: 12px;
  font-size: 0.88rem;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: all 0.2s ease;
}

.btn-copy-links:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text);
}




.guest-top-controls {
  position: absolute;
  top: 18px;
  right: 24px;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 100;
}

.btn-subtle-ctrl {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 6px 12px;
  color: var(--text-dim);
  font-size: 0.78rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
  cursor: pointer;
  transition: all 0.2s ease;
  backdrop-filter: blur(8px);
}

.btn-subtle-ctrl:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text);
  border-color: rgba(255, 255, 255, 0.25);
  transform: translateY(-1px);
}

.btn-admin-entrance:hover {
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.4);
}

/* === GUEST CARD UI (Screenshot 2 Style) === */
.guest-card-wrapper {
  width: min(1320px, 94vw);
  max-width: 1320px;
  margin: 24px auto 40px;
  padding: 0 18px;
}

.guest-main-card {
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 36px 32px 30px;
  box-shadow: 0 25px 60px rgba(0, 0, 0, 0.5);
}

.guest-header-box {
  text-align: center;
  margin-bottom: 24px;
}

.guest-folder-icon-large {
  width: 64px;
  height: 64px;
  margin: 0 auto 14px;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 10px 30px rgba(245, 158, 11, 0.15);
}

.guest-folder-icon-large svg {
  width: 36px;
  height: 36px;
}

.guest-card-title {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text);
  line-height: 1.45;
  margin-bottom: 6px;
  word-break: break-word;
}

.guest-card-stats {
  font-size: 0.88rem;
  color: var(--text-dim);
  font-weight: 500;
  letter-spacing: 0.02em;
}

.guest-breadcrumb-strip {
  margin-bottom: 16px;
  padding: 6px 12px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.guest-table-box {
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.18);
}

.guest-table-header {
  display: grid;
  grid-template-columns: 40px 1fr 90px 110px;
  align-items: center;
  padding: 11px 14px;
  background: rgba(255, 255, 255, 0.04);
  border-bottom: 1px solid var(--border);
  font-size: 0.74rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.guest-file-list {
  max-height: 56vh;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
}
.guest-file-list .file-row {
  display: grid;
  grid-template-columns: 40px 1fr 90px 110px;
  align-items: center;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  transition: background 0.15s ease;
}

.guest-file-list .file-row:last-child {
  border-bottom: none;
}

.guest-file-list .file-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.guest-bottom-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 24px;
}

@media (min-width: 768px) {
  .guest-bottom-actions { flex-direction: row; gap: 12px; }
  .guest-bottom-actions .btn-bulk-download-green,
  .guest-bottom-actions .btn-bulk-copy-subtle { width: auto; flex: 1; }
}

.btn-bulk-download-green {
  width: 100%;
  padding: 14px 20px;
  background: #059669;
  color: #ffffff;
  border: none;
  border-radius: 12px;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: all 0.2s ease;
  box-shadow: 0 4px 16px rgba(5, 150, 105, 0.3);
}

.btn-bulk-download-green:hover {
  background: #047857;
  transform: translateY(-1px);
}

.btn-bulk-copy-subtle {
  width: 100%;
  padding: 12px 20px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 12px;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: all 0.2s ease;
}

.btn-bulk-copy-subtle:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text);
}

/* === ANIMATED BOTTOM-RIGHT TOAST (Screenshot 2 Style) === */
.toast-copied-badge {
  position: fixed;
  bottom: 32px;
  right: 32px;
  background: #059669;
  color: #ffffff;
  padding: 12px 22px;
  border-radius: 14px;
  font-size: 0.92rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 10px;
  box-shadow: 0 12px 32px rgba(5, 150, 105, 0.45);
  transform: translateY(30px) scale(0.92);
  opacity: 0;
  pointer-events: none;
  transition: transform 0.32s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.25s ease;
  z-index: 10000;
}

.toast-copied-badge.show {
  transform: translateY(0) scale(1);
  opacity: 1;
}

.toast-check-icon {
  width: 22px;
  height: 22px;
  background: rgba(255, 255, 255, 0.25);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.toast-check-icon svg {
  width: 13px;
  height: 13px;
}

</style>
</head>
<body data-mode="${pageMode}">
  ${content}
  <!-- MediaInfo Inspector Modal (HaruDrive Port) -->
  <div id="modal-mediainfo" class="modal-backdrop" style="display:none;">
    <div class="modal-card" style="max-width:860px;width:96%;padding:0;overflow:hidden">
      <div class="flex items-center justify-between px-5 py-3.5" style="border-bottom:1px solid var(--border);background:rgba(20,20,40,0.9)">
        <div class="flex items-center gap-3 min-w-0">
          <div class="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style="background:rgba(99,102,241,0.2);border:1px solid rgba(99,102,241,0.3)"><span style="font-size:14px">🎞️</span></div>
          <div class="min-w-0">
            <div class="text-sm font-bold flex items-center gap-2" style="color:var(--text)">MediaInfo Inspector <span id="mi-badge-format" class="badge" style="background:rgba(168,85,247,0.2);color:#c4b5fd;border:1px solid rgba(168,85,247,0.3);font-size:10px;padding:2px 6px;border-radius:6px"></span> <span id="mi-scan-badge" class="badge" style="background:rgba(255,255,255,0.08);color:var(--text-muted);font-size:10px;padding:2px 6px;border-radius:6px">Ready</span></div>
            <div id="mi-filename" class="text-xs font-mono truncate mt-0.5" style="color:var(--text-muted)"></div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button id="mi-btn-rescan" onclick="startBinaryMediaInfoScan(true)" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold" style="background:rgba(99,102,241,0.2);color:#a5b4fc;border:1px solid rgba(99,102,241,0.3)">Scan Header</button>
          <button onclick="switchMediaInfoTab('edit')" class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3)">Paste Text</button>
          <button onclick="closeMediaInfoModal()" style="color:var(--text-dim);background:rgba(255,255,255,0.05);border:1px solid var(--border);border-radius:8px;cursor:pointer;width:32px;height:32px;display:flex;align-items:center;justify-content:center">✕</button>
        </div>
      </div>
      <div class="flex items-center gap-2 px-5 py-2.5" style="background:rgba(12,12,30,0.9);border-bottom:1px solid var(--border)">
        <button id="mi-tab-btn-tracks" onclick="switchMediaInfoTab('tracks')" class="tab-btn active text-xs" style="padding:6px 12px;border-radius:8px;background:var(--primary);color:#fff">Tracks & Specs</button>
        <button id="mi-tab-btn-text" onclick="switchMediaInfoTab('text')" class="tab-btn text-xs" style="padding:6px 12px;border-radius:8px;background:transparent;color:var(--text-muted);border:1px solid var(--border)">Official MediaInfo Text</button>
        <button id="mi-tab-btn-edit" onclick="switchMediaInfoTab('edit')" class="tab-btn text-xs" style="padding:6px 12px;border-radius:8px;background:transparent;color:var(--text-muted);border:1px solid var(--border)">Paste / Edit Report</button>
        <button id="mi-tab-btn-links" onclick="switchMediaInfoTab('links')" class="tab-btn text-xs" style="padding:6px 12px;border-radius:8px;background:transparent;color:var(--text-muted);border:1px solid var(--border)">Endpoints</button>
      </div>
      <div class="p-5 space-y-4" style="background:var(--bg);max-height:75vh;overflow-y:auto">
        <div id="mi-tab-tracks" class="space-y-4">
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div class="p-3 rounded-xl" style="background:rgba(20,20,40,0.6);border:1px solid var(--border)"><div class="text-[10px] font-semibold uppercase" style="color:var(--text-dim)">Container / Format</div><div id="mi-mime" class="text-xs font-mono font-bold mt-1 truncate" style="color:#a5b4fc">—</div></div>
            <div class="p-3 rounded-xl" style="background:rgba(20,20,40,0.6);border:1px solid var(--border)"><div class="text-[10px] font-semibold uppercase" style="color:var(--text-dim)">File Size</div><div id="mi-size" class="text-xs font-mono font-bold mt-1 truncate" style="color:#6ee7b7">—</div></div>
            <div class="p-3 rounded-xl" style="background:rgba(20,20,40,0.6);border:1px solid var(--border)"><div class="text-[10px] font-semibold uppercase" style="color:var(--text-dim)">Duration & Bitrate</div><div id="mi-duration-bitrate" class="text-xs font-bold mt-1 truncate" style="color:#fcd34d">—</div></div>
            <div class="p-3 rounded-xl" style="background:rgba(20,20,40,0.6);border:1px solid var(--border)"><div class="text-[10px] font-semibold uppercase" style="color:var(--text-dim)">Encoding App / Tool</div><div id="mi-app" class="text-xs font-mono font-medium mt-1 truncate" style="color:#7dd3fc">—</div></div>
          </div>
          <div><div class="text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-2" style="color:var(--text-muted)">Video Track(s)</div><div id="mi-video-tracks-list" class="space-y-2.5"></div></div>
          <div><div class="text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-2" style="color:var(--text-muted)">Audio Track(s)</div><div id="mi-audio-tracks-list" class="space-y-2.5"></div></div>
          <div><div class="text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-2" style="color:var(--text-muted)">Subtitle & Text Track(s)</div><div id="mi-text-tracks-list" class="space-y-2.5"></div></div>
          <div id="mi-attachments-section" class="hidden"><div class="text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-2" style="color:var(--text-muted)">Embedded Attachments / Fonts</div><div id="mi-attachments-list" class="p-3 rounded-xl font-mono text-xs max-h-32 overflow-y-auto leading-relaxed" style="background:rgba(20,20,40,0.6);border:1px solid var(--border);color:var(--text-muted)"></div></div>
          <div id="mi-menu-section" class="hidden"><div class="text-xs font-bold uppercase tracking-wider mb-2 flex items-center gap-2" style="color:var(--text-muted)">Chapters / Menus</div><div id="mi-menu-list" class="space-y-1 p-3 rounded-xl font-mono text-xs max-h-48 overflow-y-auto" style="background:rgba(20,20,40,0.6);border:1px solid var(--border)"></div></div>
        </div>
        <div id="mi-tab-text" class="hidden space-y-3">
          <div class="flex items-center justify-between"><div class="text-xs" style="color:var(--text-muted)">Standard MediaInfo Plain Text Report (libmediainfo format)</div><div class="flex items-center gap-2"><button onclick="copyMediaInfoRawText()" class="px-3 py-1.5 rounded-lg text-xs font-semibold text-white" style="background:var(--accent-gradient)">Copy MediaInfo Text</button><button onclick="downloadMediaInfoTxt()" class="tab-btn text-xs" style="padding:6px 12px;border-radius:8px;background:transparent;color:var(--text-muted);border:1px solid var(--border)">Download .txt</button></div></div>
          <div class="relative"><pre id="mi-raw-text" class="p-4 rounded-xl font-mono text-xs leading-relaxed overflow-x-auto select-all" style="background:#080814;border:1px solid var(--border);max-height:55vh;white-space:pre;color:var(--text-muted)">Analyzing media container...</pre></div>
        </div>
        <div id="mi-tab-edit" class="hidden space-y-3">
          <div class="flex items-center justify-between"><div class="text-xs" style="color:var(--text-muted)">Paste or edit raw MediaInfo text from your PC software to save it permanently:</div><button onclick="applyAndSavePastedMediaInfo()" class="px-4 py-1.5 rounded-lg text-xs font-semibold text-white" style="background:var(--accent-gradient)">Save to Database</button></div>
          <textarea id="mi-edit-textarea" rows="16" class="w-full p-4 rounded-xl font-mono text-xs leading-relaxed focus:outline-none" style="background:#080814;border:1px solid var(--border);color:#e6edf3;resize:vertical" placeholder="Paste full MediaInfo text here (General, Video, Audio #1, Text #1, etc.)..."></textarea>
        </div>
        <div id="mi-tab-links" class="hidden space-y-3">
          <div class="text-xs" style="color:var(--text-muted)">Direct stream endpoints (for external players):</div>
          <div id="mi-links-list" class="space-y-2 font-mono text-xs"></div>
        </div>
      </div>
    </div>
  </div>
  <script>
let currentPath = '';
let currentFolderId = '';
let allFiles = [];
let currentFolderStats = null;
let _sortState = { col: null, dir: 1 };
let availableFolders = [''];
// Storage mode (hf | gdrive) - persisted
function getStorageMode(){ try{ return localStorage.getItem('harudrive_storage_mode') || 'gdrive'; }catch(e){ return 'gdrive'; } }
function setStorageMode(m){ try{ localStorage.setItem('harudrive_storage_mode', m); document.cookie='harudrive_mode='+m+'; Path=/; Max-Age=2592000; SameSite=Lax'; }catch(e){} updateStorageModeUI(); }
function toggleStorageMode(){ const cur=getStorageMode(); const nxt=cur==='hf'?'gdrive':'hf'; setStorageMode(nxt); loadFolder('', ''); }
function updateStorageModeUI(){ const m=getStorageMode(); const cur=m==='gdrive'?'GDrive':'HF'; const nxt=m==='gdrive'?'HF':'GDrive'; const l=document.getElementById('storageModeLabel'); if(l) l.textContent='Mode: '+cur; const l2=document.getElementById('storageModeLabelAdmin'); if(l2) l2.textContent='Mode: '+cur; const t1=document.getElementById('storageModeToggle'); if(t1) t1.title='Saat ini: '+cur+' \u2014 klik untuk ganti ke '+nxt; const t2=document.getElementById('storageModeToggleAdmin'); if(t2) t2.title='Saat ini: '+cur+' \u2014 klik untuk ganti ke '+nxt; const isGDrive=m==='gdrive'; const mb=document.getElementById('cloudMirrorBtn'); if(mb) mb.style.display=isGDrive?'none':''; const sb=document.getElementById('syncIndexBtn'); if(sb) sb.style.display=isGDrive?'none':''; const ub=document.getElementById('uploadBtn'); if(ub) ub.style.display=isGDrive?'none':''; const fb=document.getElementById('newFolderBtn'); if(fb) fb.style.display=isGDrive?'none':''; }
async function updateBandwidthIndicator(){ try{ const res=await fetch('/api/bandwidth'); if(!res.ok) return; const data=await res.json(); const stats=data.stats||[]; const hf=stats.find(function(s){return s.mode==='hf';}); const gd=stats.find(function(s){return s.mode==='gdrive';}); const fmt=function(b){ if(!b) return '-'; const v=Number(b); if(v>=1099511627776) return (v/1099511627776).toFixed(2)+' TB'; if(v>=1073741824) return (v/1073741824).toFixed(2)+' GB'; if(v>=1048576) return (v/1048576).toFixed(2)+' MB'; if(v>=1024) return (v/1024).toFixed(2)+' KB'; return v+' B'; }; const elHf=document.getElementById('bwHf'); if(elHf) elHf.textContent='HF: ' + (hf? fmt(hf.bytes) + ' ('+hf.requests+' req)':'-'); const elGd=document.getElementById('bwGDrive'); if(elGd) elGd.textContent='GDrive: ' + (gd? fmt(gd.bytes) + ' ('+gd.requests+' req)':'-'); const elUp=document.getElementById('bwUpdated'); if(elUp && stats.length){ const maxUpdated=Math.max.apply(null, stats.map(function(s){return s.updated||0;})); if(maxUpdated) elUp.textContent='Updated: ' + new Date(maxUpdated).toLocaleString(); } }catch(e){} }
let activeFilter = 'all';
const selectedFiles = new Set();
let plyrPlayerInstance = null;
const isPageAdmin = document.body.getAttribute('data-mode') === 'admin';
let selectedUploadFile = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('haruTheme') === 'light') {
    document.body.classList.add('light');
    updateThemeIcon(true);
  }

  updateStorageModeUI();
  // Login page: skip file-console initialization.
  if (document.body.getAttribute('data-mode') === 'login') {
    return;
  }

  if (isPageAdmin) {
    initAdminConsole();
    updateBandwidthIndicator();
    setInterval(updateBandwidthIndicator, 30000);
  } else {
    // Guest Mode / Shared Folder View
    const pathName = window.location.pathname;
    if (pathName.startsWith('/folder/')) {
      const fId = pathName.replace('/folder/', '').split('/')[0];
      loadFolder('', fId);
    } else {
      const urlParams = new URLSearchParams(window.location.search);
      loadFolder(urlParams.get('p') || '', '');
    }
  }

  document.getElementById('darkToggle')?.addEventListener('click', toggleTheme);
  document.getElementById('refreshBtn')?.addEventListener('click', () => loadFolder(currentPath, currentFolderId));
  
  document.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.getAttribute('data-filter') || 'all';
      renderFileList();
    });
  });

    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
      searchInput.addEventListener('input', debounce(handleSearch, 300));
    }
    const searchClearBtn = document.getElementById('searchClearBtn');
    if (searchInput && searchClearBtn) {
      const toggleClear = () => { searchClearBtn.style.display = searchInput.value ? 'flex' : 'none'; };
      searchInput.addEventListener('input', toggleClear);
      toggleClear();
      searchClearBtn.addEventListener('click', () => { searchInput.value = ''; toggleClear(); searchInput.focus(); searchInput.dispatchEvent(new Event('input')); });
    }
  
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchInput?.focus();
    }
  });

  // Table sorting for public & admin (Nama / Ukuran / Diperbarui)
  document.querySelectorAll('.table-header .gdi-sort-header').forEach(function(h){
    h.addEventListener('click', function(){
      const col = h.getAttribute('data-sort');
      if (_sortState.col === col) _sortState.dir *= -1;
      else { _sortState.col = col; _sortState.dir = 1; }
      document.querySelectorAll('.table-header .gdi-sort-header').forEach(function(x){ x.classList.remove('asc','desc'); });
      h.classList.add(_sortState.dir === 1 ? 'asc' : 'desc');
      const list = document.getElementById('fileListContainer');
      if (!list) return;
      const rows = Array.from(list.children).filter(function(c){ return c.classList.contains('file-row'); });
      rows.sort(function(a,b){
        if (col === 'size') return _sortState.dir * ((parseFloat(a.getAttribute('data-bytes'))||0) - (parseFloat(b.getAttribute('data-bytes'))||0));
        if (col === 'date') return _sortState.dir * (new Date(a.getAttribute('data-date')||0) - new Date(b.getAttribute('data-date')||0));
        const an = (a.getAttribute('data-name')||'').toLowerCase();
        const bn = (b.getAttribute('data-name')||'').toLowerCase();
        return _sortState.dir * an.localeCompare(bn);
      });
      rows.forEach(function(r){ list.appendChild(r); });
    });
  });

  window.addEventListener('popstate', handlePopState);
});

// Admin Session & PIN Gate
function initAdminConsole() {
  const gate = document.getElementById('adminLoginGate');
  const main = document.getElementById('adminMainContent');
  const savedPin = localStorage.getItem('harudrive_admin_pin') || getCookie('harudrive_admin_pin');

  if (savedPin === '290722') {
    if (gate) gate.style.display = 'none';
    if (main) main.style.display = 'block';
    const pathName = window.location.pathname;
    if (pathName.startsWith('/folder/')) {
      const fId = pathName.replace('/folder/', '').split('/')[0];
      loadFolder('', fId);
    } else {
      const urlParams = new URLSearchParams(window.location.search);
      loadFolder(urlParams.get('p') || '', '');
    }
    fetchFolderTree(); fetchAndRenderTasks();
  } else {
    if (gate) gate.style.display = 'flex';
    if (main) main.style.display = 'none';
  }
}

function unlockAdminConsole() {
  const pinInput = document.getElementById('gatePinInput');
  const errText = document.getElementById('loginPinError');
  const pin = (pinInput?.value || '').trim();

  if (pin === '290722') {
    localStorage.setItem('harudrive_admin_pin', '290722');
    setCookie('harudrive_admin_pin', '290722', 30);
    if (errText) errText.style.display = 'none';
    initAdminConsole();
  } else {
    if (errText) {
      errText.textContent = 'PIN Admin salah. Silakan coba lagi.';
      errText.style.display = 'block';
    }
  }
}

function lockAdminSession() {
  localStorage.removeItem('harudrive_admin_pin');
  deleteCookie('harudrive_admin_pin');
  window.location.reload();
}

// Navigation
function navigateTo(path, id = '', pushHistory = true) {
  if (pushHistory) {
    const targetUrl = id ? ('/folder/' + id) : (path ? ('/?p=' + encodeURIComponent(path)) : '/');
    window.history.pushState({ path, id }, '', targetUrl);
  }
  loadFolder(path, id);
}

function navigateToAdmin(path) {
  currentPath = path;
  loadFolder(path, '');
}

function handlePopState(e) {
  const pathName = window.location.pathname;
  if (pathName.startsWith('/folder/')) {
    const fId = pathName.replace('/folder/', '').split('/')[0];
    loadFolder('', fId);
  } else {
    const urlParams = new URLSearchParams(window.location.search);
    loadFolder(urlParams.get('p') || '', '');
  }
}

// Folder Tree for Pickers
async function fetchFolderTree() {
  try {
    const res = await fetch('/api/folders');
    if (res.ok) {
      const data = await res.json();
      availableFolders = data.folders || [''];
    }
  } catch (e) {}
}

function renderFolderPickerUI(containerId, inputId, selectedValue = '') {
  const container = document.getElementById(containerId);
  const hiddenInput = document.getElementById(inputId);
  if (!container) return;

  hiddenInput.value = selectedValue;
  let html = '';
  availableFolders.forEach(f => {
    const isSel = f === selectedValue;
    const displayName = f ? ('/' + f) : 'Root (/)';
    const click = 'selectFolderPickerItem(' + JSON.stringify(containerId) + ', ' + JSON.stringify(inputId) + ', ' + JSON.stringify(f) + ')';
    html += '<div class="picker-item ' + (isSel ? 'active' : '') + '" onclick="' + click.replace(/"/g, '&quot;') + '">';
    html += '  <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    html += '  <span>' + escapeHtml(displayName) + '</span>';
    html += '</div>';
  });
  container.innerHTML = html;
}

function selectFolderPickerItem(containerId, inputId, folderPath) {
  renderFolderPickerUI(containerId, inputId, folderPath);
}

// Core File Loader
async function loadFolder(path = '', id = '') {
  currentPath = path;
  currentFolderId = id;
  selectedFiles.clear();
  updateBulkToolbar();
  _sortState = { col: null, dir: 1 };
  document.querySelectorAll('.table-header .gdi-sort-header').forEach(function(x){ x.classList.remove('asc','desc'); });

  const container = document.getElementById('fileListContainer');
  if (container) {
    container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);"><div class="pulse-dot" style="margin: 0 auto 12px; width: 12px; height: 12px;"></div><p>Memuat daftar file...</p></div>';
  }

  try {
    const _mode = getStorageMode();
    let fetchUrl = '/api/list';
    if (_mode === 'gdrive') {
      const gId = id || path || '';
      if (gId) fetchUrl += '?id=' + encodeURIComponent(gId) + '&mode=gdrive';
      else fetchUrl += '?mode=gdrive';
    } else {
      if (id) fetchUrl += '?id=' + encodeURIComponent(id);
      else if (path) fetchUrl += '?path=' + encodeURIComponent(path);
    }

    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error('HTTP Error ' + res.status);
    const data = await res.json();

    currentPath = data.currentPath || '';
    currentFolderId = data.folderId || '';
    currentFolderStats = data.folderStats || null;
    allFiles = data.files || [];

    updateBreadcrumbs();
    renderFileList();
  } catch (err) {
    if (container) {
      container.innerHTML = '<div style="text-align: center; padding: 40px; color: #ef4444;"><p>Gagal memuat: ' + escapeHtml(err.message) + '</p><button class="nav-btn" style="margin-top: 12px;" onclick="loadFolder(currentPath, currentFolderId)">Coba Lagi</button></div>';
    }
  }
}

// Copy Toast Notification
function showCopyToast(message) {
  const badge = document.getElementById('toastCopiedBadge');
  const text = document.getElementById('toastCopiedText');
  if (badge && text) {
    text.textContent = message || 'Link copied';
    badge.classList.add('show');
    clearTimeout(window._copyToastTimer);
    window._copyToastTimer = setTimeout(() => {
      badge.classList.remove('show');
    }, 2400);
  } else {
    alert(message || 'Link copied');
  }
}

function copyFolderLink(id, path) {
  const url = id ? (window.location.origin + '/folder/' + id) : (window.location.origin + '/?p=' + encodeURIComponent(path));
  navigator.clipboard.writeText(url).then(() => {
    showCopyToast('Link folder disalin');
  }).catch(() => {
    prompt('Salin link folder:', url);
  });
}

function copyShortLink(id, path) {
  const url = id ? (window.location.origin + '/file/' + id) : (window.location.origin + '/d/' + encodeURIComponent(path));
  navigator.clipboard.writeText(url).then(() => {
    showCopyToast('1 link copied');
  }).catch(() => {
    prompt('Salin link file:', url);
  });
}

function bulkCopyLinks() {
  if (selectedFiles.size === 0) {
    showCopyToast('Pilih setidaknya 1 item');
    return;
  }
  const links = [];
  allFiles.forEach(f => {
    if (selectedFiles.has(f.path)) {
      const isDir = f.mimeType === 'application/vnd.google-apps.folder';
      if (isDir) {
        links.push(f.id ? (window.location.origin + '/folder/' + f.id) : (window.location.origin + '/?p=' + encodeURIComponent(f.path)));
      } else {
        links.push(f.id ? (window.location.origin + '/file/' + f.id) : (window.location.origin + '/d/' + encodeURIComponent(f.path)));
      }
    }
  });

  const textToCopy = links.join(String.fromCharCode(10));
  navigator.clipboard.writeText(textToCopy).then(() => {
    showCopyToast(links.length + ' links copied');
  }).catch(() => {
    prompt('Salin link:', textToCopy);
  });
}

function bulkDownloadSelected() {
  const filesToDownload = allFiles.filter(f => selectedFiles.has(f.path) && f.mimeType !== 'application/vnd.google-apps.folder');
  if (filesToDownload.length === 0) {
    alert('Pilih setidaknya 1 file untuk di-download.');
    return;
  }
  filesToDownload.forEach((f, idx) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = '/d/' + f.id;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, idx * 500);
  });
}

function updateBreadcrumbs() {
  const nav = document.getElementById('breadcrumbNav');
  if (!nav) return;
  
  const isGuestCard = !!document.getElementById('guestCardTitle');
  const homeClick = isPageAdmin ? "navigateToAdmin('')" : (isGuestCard ? "navigateTo('/', '')" : "navigateTo('', '')");
  let html = '<a href="/" class="crumb" onclick="' + homeClick + '; return false;"><svg class="icon icon-xs" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg><span>Home</span></a>';
  
  if (currentPath) {
    const parts = currentPath.split('/').filter(Boolean);
    let accum = '';
    parts.forEach((part, idx) => {
      accum = accum ? (accum + '/' + part) : part;
      const isLast = idx === parts.length - 1;
      html += '<span class="crumb-separator" style="margin: 0 4px; color: var(--text-dim);">/</span>';
      if (isLast) {
        html += '<span class="crumb active" title="' + escapeHtml(part) + '" style="color: var(--text); font-weight: 600;">' + escapeHtml(part) + '</span>';
      } else {
        const click = isPageAdmin ? ('navigateToAdmin(' + JSON.stringify(accum) + ')') : ('navigateTo(' + JSON.stringify(accum) + ', "")');
        html += '<a href="javascript:void(0)" class="crumb" onclick="' + click.replace(/"/g, '&quot;') + '; return false;">' + escapeHtml(part) + '</a>';
      }
    });
  }
  nav.innerHTML = html;
}

function renderFileList() {
  const container = document.getElementById('fileListContainer');
  if (!container) return;

  const cardTitle = document.getElementById('guestCardTitle');
  const statsEl = document.getElementById('guestCardStats') || document.getElementById('folderStatsLabel');
  if (cardTitle) {
    if (!currentPath) {
      cardTitle.textContent = 'HaruDrive Storage';
    } else {
      const parts = currentPath.split('/');
      cardTitle.textContent = parts[parts.length - 1];
    }
  }
  if (statsEl) {
    let fCount = 0;
    allFiles.forEach(f => {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        fCount++;
      }
    });

    let fileCount = 0;
    let totalBytes = 0;
    if (currentFolderStats && (currentFolderStats.fileCount > 0 || currentFolderStats.fileSize > 0)) {
      fileCount = currentFolderStats.fileCount;
      totalBytes = currentFolderStats.fileSize;
    } else {
      allFiles.forEach(f => {
        if (f.mimeType !== 'application/vnd.google-apps.folder') {
          fileCount++;
          totalBytes += (f.size || 0);
        }
      });
    }

    let sList = [];
    if (fCount > 0 && fileCount > 0) {
      sList.push(fCount + ' folders • ' + fileCount + ' files — ' + formatBytes(totalBytes));
    } else if (fileCount > 0) {
      sList.push(fileCount + ' files — ' + formatBytes(totalBytes));
    } else if (fCount > 0) {
      sList.push(fCount + ' folders');
    } else {
      sList.push('Folder kosong');
    }
    statsEl.textContent = sList.join('');
  }

  const filtered = allFiles.filter(item => {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'folder') return item.mimeType === 'application/vnd.google-apps.folder';
    if (activeFilter === 'video') return item.mimeType.startsWith('video/');
    if (activeFilter === 'archive') return item.mimeType.includes('zip') || item.mimeType.includes('rar') || item.mimeType.includes('tar') || item.mimeType.includes('7z');
    if (activeFilter === 'document') return item.mimeType.includes('pdf') || item.mimeType.includes('text');
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);"><p>Tidak ada file di direktori ini.</p></div>';
    return;
  }

  let html = '';
  filtered.forEach(file => {
    const isDir = file.mimeType === 'application/vnd.google-apps.folder';
    const isVideo = file.mimeType.startsWith('video/');
    const iconType = isDir ? 'folder' : (isVideo ? 'video' : (file.mimeType.includes('zip') ? 'archive' : 'file'));
    const isChecked = selectedFiles.has(file.path);

    const safeName = escapeHtml(file.name);

    let clickAction = '';
    if (isDir) {
      clickAction = isPageAdmin ? ('navigateToAdmin(' + JSON.stringify(file.path) + ')') : ('navigateTo(' + JSON.stringify(file.path) + ', ' + JSON.stringify(file.id) + ')');
    } else if (isVideo) {
      clickAction = 'playVideo(' + JSON.stringify(file.id) + ', ' + JSON.stringify(file.name) + ')';
    } else {
      clickAction = 'downloadFile(' + JSON.stringify(file.id) + ')';
    }

    let copyFunc = isDir
      ? ('copyFolderLink(' + JSON.stringify(file.id) + ', ' + JSON.stringify(file.path) + ')')
      : ('copyShortLink(' + JSON.stringify(file.id) + ', ' + JSON.stringify(file.path) + ')');

    html += '<div class="file-row ' + (isDir ? 'is-folder' : '') + '" data-name="' + escapeHtml(file.name) + '" data-bytes="' + (file.size || 0) + '" data-date="' + escapeHtml(file.modifiedTime || '') + '">';
    html += '  <div class="col-cb"><input type="checkbox" ' + (isChecked ? 'checked' : '') + ' onchange="toggleItemSelect(' + JSON.stringify(file.path).replace(/"/g, '&quot;') + ', this.checked)"></div>';
    html += '  <div class="file-name-cell" onclick="' + clickAction.replace(/"/g, '&quot;') + '" title="' + (isDir ? 'Buka Folder' : (isVideo ? 'Klik untuk Putar Video' : 'Download File')) + '">';
    html += '    <div class="file-icon-box ' + iconType + '">' + getModernSvgIcon(iconType) + '</div>';
    html += '    <span class="file-title" title="' + safeName + '">' + safeName + '</span>';
    html += '  </div>';
    html += '  <div class="file-size-cell" style="text-align: right;">' + (isDir ? (file.size > 0 ? formatBytes(file.size) : '-') : formatBytes(file.size)) + '</div>';
    
    html += '  <div class="file-date-cell">' + formatDate(file.modifiedTime) + '</div>';

    html += '  <div class="file-actions-cell" style="text-align: center;">';
    
    const mediaInfoBtn = isVideo ? '<button class="btn-act" onclick="openMediaInfoModal(' + JSON.stringify(file.id).replace(/"/g, '&quot;') + ', ' + JSON.stringify(file.path).replace(/"/g, '&quot;') + ', ' + JSON.stringify(file.name).replace(/"/g, '&quot;') + ')" title="MediaInfo"><svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 9h6M9 13h6M9 17h4"/></svg></button>' : '';
    if (!isPageAdmin) {
      if (!isDir) {
        html += '    <a class="btn-act" href="/d/' + file.id + '" title="Download File"><svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></a>';
        html += mediaInfoBtn;
        html += '    <button class="btn-act" onclick="' + copyFunc.replace(/"/g, '&quot;') + '" title="Salin Link File"><svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>';
      } else {
        html += '    <button class="btn-act" onclick="' + copyFunc.replace(/"/g, '&quot;') + '" title="Salin Link Folder"><svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>';
      }
    } else {
      html += '    <button class="btn-act" onclick="openRenameModal(' + JSON.stringify(file.path).replace(/"/g, '&quot;') + ', ' + JSON.stringify(file.name).replace(/"/g, '&quot;') + ')" title="Ubah Nama"><svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>';
      html += '    <button class="btn-act" onclick="openMoveModalSingle(' + JSON.stringify(file.path).replace(/"/g, '&quot;') + ')" title="Pindahkan"><svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="5 9 2 12 5 15"/><polyline points="9 5 12 2 15 5"/><polyline points="15 19 12 22 9 19"/><polyline points="19 9 22 12 19 15"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/></svg></button>';
      html += mediaInfoBtn;
      html += '    <button class="btn-act" onclick="' + copyFunc.replace(/"/g, '&quot;') + '" title="Salin Link"><svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></button>';
      html += '    <button class="btn-act btn-act-danger" onclick="deleteItem(' + JSON.stringify(file.path).replace(/"/g, '&quot;') + ')" title="Hapus"><svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>';
    }
    
    html += '  </div>';
    html += '</div>';
  });

  container.innerHTML = html;
}

function toggleItemSelect(itemPath, checked) {
  if (checked) selectedFiles.add(itemPath);
  else selectedFiles.delete(itemPath);
  updateBulkToolbar();
}

function toggleSelectAll(checked) {
  if (checked) {
    allFiles.forEach(f => selectedFiles.add(f.path));
  } else {
    selectedFiles.clear();
  }
  renderFileList();
  updateBulkToolbar();
}

function updateBulkToolbar() {
  const count = selectedFiles.size;
  const countSpan = document.getElementById('bulkCount');
  if (countSpan) countSpan.textContent = count + ' Dipilih';
  
  const dlBtnText = document.getElementById('bulkDownloadText');
  if (dlBtnText) dlBtnText.textContent = 'Download Selected (' + count + ')';

  // Download is only meaningful for files, not folders.
  const fileSelCount = allFiles.filter(f => selectedFiles.has(f.path) && f.mimeType !== 'application/vnd.google-apps.folder').length;
  const hasFileSel = fileSelCount > 0;
  ['bulkDownloadBtn', 'btnBulkDownload'].forEach(id => {
    const b = document.getElementById(id);
    if (b) {
      b.disabled = !hasFileSel;
      b.style.opacity = hasFileSel ? '1' : '0.45';
      b.style.pointerEvents = hasFileSel ? 'auto' : 'none';
    }
  });

  // Keep the header "select all" checkbox in sync with the current selection.
  const selectAll = document.getElementById('selectAllCheckbox');
  if (selectAll) {
    const total = allFiles.length;
    selectAll.checked = total > 0 && count === total;
    selectAll.indeterminate = count > 0 && count < total;
  }

  const toolbar = document.getElementById('bulkToolbar');
  if (toolbar) {
    toolbar.style.display = count > 0 ? 'flex' : 'none';
  }
}

function clearBulkSelection() {
  selectedFiles.clear();
  const selectAll = document.getElementById('selectAllCheckbox');
  if (selectAll) selectAll.checked = false;
  renderFileList();
  updateBulkToolbar();
}

async function bulkDeleteSelected() {
  if (selectedFiles.size === 0) return;
  if (!confirm('Yakin ingin menghapus ' + selectedFiles.size + ' item yang dipilih?')) return;

  const pin = localStorage.getItem('harudrive_admin_pin') || getCookie('harudrive_admin_pin') || prompt('Masukkan PIN Admin:');
  if (!pin) return;

  try {
    const res = await fetch('/api/admin/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: Array.from(selectedFiles), pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      clearBulkSelection();
      loadFolder(currentPath, currentFolderId);
      fetchFolderTree(); fetchAndRenderTasks();
    } else {
      alert('Gagal: ' + (data.error || 'Error'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// Admin Action Modals & Handlers
function openUploadModal() {
  const m = document.getElementById('uploadModal');
  const targetDirInput = document.getElementById('uploadTargetDirInput');
  if (!m) return;

  targetDirInput.value = currentPath;
  selectedUploadFile = null;
  document.getElementById('selectedFileInfo').style.display = 'none';
  document.getElementById('uploadProgressBox').style.display = 'none';
  renderFolderPickerUI('uploadFolderPicker', 'uploadTargetDirInput', currentPath);
  m.style.display = 'flex';
}
function closeUploadModal() {
  const m = document.getElementById('uploadModal');
  if (m) m.style.display = 'none';
}
function handleFileSelected(files) {
  if (files && files.length > 0) {
    selectedUploadFile = files[0];
    document.getElementById('selectedFileName').textContent = '📄 ' + selectedUploadFile.name + ' (' + formatBytes(selectedUploadFile.size) + ')';
    document.getElementById('selectedFileInfo').style.display = 'block';
  }
}
async function submitManualUpload() {
  if (!selectedUploadFile) return alert('Silakan pilih file terlebih dahulu!');
  const targetDir = (document.getElementById('uploadTargetDirInput').value || '').trim();
  const pin = localStorage.getItem('harudrive_admin_pin') || '290722';

  const progressBox = document.getElementById('uploadProgressBox');
  const progressBar = document.getElementById('uploadProgressBar');
  const statusText = document.getElementById('uploadStatusText');
  const btn = document.getElementById('startUploadBtn');

  progressBox.style.display = 'block';
  progressBar.style.width = '45%';
  statusText.textContent = 'Mengupload ' + selectedUploadFile.name + '...';
  btn.disabled = true;

  const formData = new FormData();
  formData.append('file', selectedUploadFile);
  formData.append('target_dir', targetDir);
  formData.append('admin_pin', pin);

  try {
    const res = await fetch('/api/admin/upload', {
      method: 'POST',
      body: formData
    });
    progressBar.style.width = '100%';
    const data = await res.json();
    if (res.ok && data.success) {
      closeUploadModal();
      loadFolder(currentPath, currentFolderId);
      alert('✅ File berhasil diunggah!');
    } else {
      alert('Gagal upload: ' + (data.error || 'Terjadi kesalahan'));
    }
  } catch (err) {
    alert('Upload error: ' + err.message);
  } finally {
    btn.disabled = false;
    progressBox.style.display = 'none';
  }
}

function openRenameModal(oldPath, oldName) {
  const m = document.getElementById('renameModal');
  const oldPathInput = document.getElementById('renameOldPath');
  const newNameInput = document.getElementById('renameNewNameInput');
  if (!m) return;

  oldPathInput.value = oldPath;
  newNameInput.value = oldName;
  m.style.display = 'flex';
  newNameInput.focus();
}
function closeRenameModal() {
  const m = document.getElementById('renameModal');
  if (m) m.style.display = 'none';
}
async function submitRename() {
  const oldPath = document.getElementById('renameOldPath').value;
  const newName = (document.getElementById('renameNewNameInput').value || '').trim();
  if (!newName) return alert('Nama baru tidak boleh kosong!');

  const pathParts = oldPath.split('/');
  pathParts.pop();
  const newPath = pathParts.length ? (pathParts.join('/') + '/' + newName) : newName;
  const pin = localStorage.getItem('harudrive_admin_pin') || '290722';

  try {
    const res = await fetch('/api/admin/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_path: oldPath, new_path: newPath, admin_pin: pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      closeRenameModal();
      loadFolder(currentPath, currentFolderId);
      fetchFolderTree();
    } else {
      alert('Gagal ubah nama: ' + (data.error || 'Error'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

function openMoveModalSingle(filePath) {
  const m = document.getElementById('moveModal');
  const desc = document.getElementById('moveTargetDesc');
  if (!m) return;

  selectedFiles.clear();
  selectedFiles.add(filePath);
  desc.textContent = 'Memindahkan: ' + filePath;
  renderFolderPickerUI('moveFolderPicker', 'moveDestinationInput', currentPath);
  m.style.display = 'flex';
}
function closeMoveModal() {
  const m = document.getElementById('moveModal');
  if (m) m.style.display = 'none';
}
async function submitMove() {
  const dest = (document.getElementById('moveDestinationInput').value || '').trim();
  const pin = localStorage.getItem('harudrive_admin_pin') || '290722';
  const paths = Array.from(selectedFiles);

  try {
    const res = await fetch('/api/admin/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: paths, destination: dest, admin_pin: pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      closeMoveModal();
      clearBulkSelection();
      loadFolder(currentPath, currentFolderId);
      fetchFolderTree();
    } else {
      alert('Gagal memindahkan: ' + (data.error || 'Error'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

function openNewFolderModal() {
  const m = document.getElementById('newFolderModal');
  const input = document.getElementById('newFolderNameInput');
  if (!m) return;
  if (input) input.value = '';
  m.style.display = 'flex';
  input?.focus();
}
function closeNewFolderModal() {
  const m = document.getElementById('newFolderModal');
  if (m) m.style.display = 'none';
}
async function submitNewFolder() {
  const folderName = (document.getElementById('newFolderNameInput').value || '').trim();
  if (!folderName) return alert('Masukkan nama folder!');

  const fullPath = currentPath ? (currentPath + '/' + folderName) : folderName;
  const pin = localStorage.getItem('harudrive_admin_pin') || '290722';

  try {
    const res = await fetch('/api/admin/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fullPath, admin_pin: pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      closeNewFolderModal();
      loadFolder(currentPath, currentFolderId);
      fetchFolderTree();
    } else {
      alert('Gagal membuat folder: ' + (data.error || 'Error'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function deleteItem(itemPath) {
  if (!confirm('Yakin ingin menghapus ' + itemPath + '?')) return;
  const pin = localStorage.getItem('harudrive_admin_pin') || '290722';

  try {
    const res = await fetch('/api/admin/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: itemPath, admin_pin: pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      loadFolder(currentPath, currentFolderId);
      fetchFolderTree();
    } else {
      alert('Gagal menghapus: ' + (data.error || 'Error'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function syncFromHF() {
  const btn = document.getElementById('syncHfBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Menyinkronkan...'; }
  const pin = localStorage.getItem('harudrive_admin_pin') || '290722';

  try {
    const res = await fetch('/api/admin/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin_pin: pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      const suffix = (data.truncated ? (' [dibatasi ' + data.items + ' item, jalankan lagi untuk melanjutkan]') : '');
      alert('Sinkronisasi index berhasil: ' + data.items + ' file' + suffix);
      loadFolder(currentPath, currentFolderId);
      fetchFolderTree();
    } else {
      alert('Gagal sinkronisasi: ' + (data.error || 'Error'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Sinkronkan D1 dari HF'; }
  }
}

// Cloud Mirror Modal
async function openMirrorModal() {
  const m = document.getElementById('mirrorModal');
  if (m) {
    await fetchFolderTree(); fetchAndRenderTasks();
    renderFolderPickerUI('mirrorFolderPicker', 'mirrorTargetPath', currentPath);
    m.style.display = 'flex';
  }
}
function closeMirrorModal() {
  const m = document.getElementById('mirrorModal');
  if (m) m.style.display = 'none';
}
async function submitCloudMirror() {
  const urlInput = document.getElementById('mirrorGdriveUrl');
  const targetPath = (document.getElementById('mirrorTargetPath').value || '').trim();
  const gdriveUrl = (urlInput?.value || '').trim();
  if (!gdriveUrl) return alert('Masukkan URL Google Drive!');

  const pin = localStorage.getItem('harudrive_admin_pin') || '290722';
  const btn = document.getElementById('startMirrorBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Memulai Runner Cloud...'; }

  try {
    const res = await fetch('/api/admin/mirror', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gdrive_url: gdriveUrl, target_path: targetPath, pin: pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert('Tugas mirror berhasil dijadwalkan di Cloudflare & GitHub Actions! ⚡');
      closeMirrorModal();
      if (urlInput) urlInput.value = '';
      openTaskManagerModal();
    } else {
      alert('Gagal: ' + (data.error || 'Error scheduling mirror'));
    }
  } catch (err) {
    alert('Network Error: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Mulai Mirror Sekarang'; }
  }
}

// Live Task Manager Modal
async function openTaskManagerModal() {
  const m = document.getElementById('taskManagerModal');
  if (m) {
    m.style.display = 'flex';
    fetchAndRenderTasks();
    if (!window.taskInterval) {
      window.taskInterval = setInterval(fetchAndRenderTasks, 5000);
    }
  }
}
function closeTaskManagerModal() {
  const m = document.getElementById('taskManagerModal');
  if (m) {
    m.style.display = 'none';
    if (window.taskInterval) {
      clearInterval(window.taskInterval);
      window.taskInterval = null;
    }
  }
}
async function fetchAndRenderTasks() {
  const container = document.getElementById('taskManagerList');
  if (!container) return;

  try {
    const res = await fetch('/api/admin/mirror-tasks');
    if (!res.ok) return;
    const data = await res.json();
    const runs = data.runs || [];

    if (runs.length === 0) {
      container.innerHTML = '<div style="text-align: center; padding: 24px; color: var(--text-dim);">Belum ada antrean mirroring aktif.</div>';
      return;
    }

    let html = '';
    runs.forEach(r => {
      const isRunning = r.status === 'in_progress' || r.status === 'queued';
      const isSuccess = r.conclusion === 'success';
      const isFailed = r.conclusion === 'failure';
      const isCancelled = r.conclusion === 'cancelled';

      let statusBadge = '<span class="task-badge badge-warning">Dalam Antrean</span>';
      if (r.status === 'in_progress') {
        statusBadge = '<span class="task-badge badge-info"><span class="pulse-dot" style="display:inline-block; width:6px; height:6px; margin-right:4px;"></span>Sedang Berjalan</span>';
      } else if (isSuccess) {
        statusBadge = '<span class="task-badge badge-success">Selesai 100%</span>';
      } else if (isFailed) {
        statusBadge = '<span class="task-badge badge-danger">Gagal</span>';
      } else if (isCancelled) {
        statusBadge = '<span class="task-badge badge-secondary">Dibatalkan</span>';
      }

      html += '<div class="task-card-item">';
      html += '  <div class="task-card-header">';
      html += '    <div style="font-weight: 600; font-size: 0.85rem; color: var(--text);">' + escapeHtml(r.title || 'Mirroring Task') + '</div>';
      html += '    <div>' + statusBadge + '</div>';
      html += '  </div>';
      html += '  <div class="task-card-meta">';
      html += '    <span>ID: #' + r.id + '</span>';
      html += '    <span>Dimulai: ' + formatTimeAgo(r.created_at) + '</span>';
      html += '    <a href="' + r.html_url + '" target="_blank" style="color: var(--accent-cyan); text-decoration: underline;">Buka Live Logs ↗</a>';
      html += '  </div>';
      if (isRunning) {
        html += '  <div style="margin-top: 8px; text-align: right;">';
        html += '    <button class="btn-ctrl-sm btn-act-danger" onclick="cancelMirrorTask(' + r.id + ')">Batalkan Task</button>';
        html += '  </div>';
      }
      html += '</div>';
    });

    container.innerHTML = html;
  } catch (err) {}
}

async function cancelMirrorTask(runId) {
  if (!confirm('Yakin ingin membatalkan proses mirror ini?')) return;
  const pin = localStorage.getItem('harudrive_admin_pin') || '290722';

  try {
    const res = await fetch('/api/admin/mirror-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: runId, pin: pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert('Task berhasil dibatalkan.');
      fetchAndRenderTasks();
    } else {
      alert('Gagal: ' + (data.error || 'Error'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// Video Player Modal
function playVideo(fileId, fileName) {
  const modal = document.getElementById('videoModal');
  const title = document.getElementById('videoModalTitle');
  const video = document.getElementById('plyrPlayer');
  const extContainer = document.getElementById('externalPlayersContainer');
  if (!modal || !video) return;

  title.textContent = fileName || 'Video Player';
  const _vmode = getStorageMode();
  const videoUrl = window.location.origin + '/d/' + fileId + '/' + encodeURIComponent(fileName || 'video') + (_vmode === 'gdrive' ? '?mode=gdrive' : '');
  video.src = videoUrl;

  if (plyrPlayerInstance) {
    plyrPlayerInstance.destroy();
  }
  plyrPlayerInstance = new Plyr(video, {
    autoplay: false,
    controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'captions', 'settings', 'pip', 'airplay', 'fullscreen']
  });

  if (extContainer) {
    let eHtml = '';
    eHtml += '<a href="vlc://' + videoUrl + '" class="btn-ext-player"><span>VLC Player</span></a>';
    eHtml += '<a href="potplayer://' + videoUrl + '" class="btn-ext-player"><span>PotPlayer</span></a>';
    eHtml += '<a href="intent:' + videoUrl + '#Intent;type=video/*;package=com.mxtech.videoplayer.ad;end" class="btn-ext-player"><span>MX Player</span></a>';
    eHtml += '<a href="' + videoUrl + '" target="_blank" download class="btn-ext-player" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border-color: rgba(16, 185, 129, 0.3); margin-left:auto;"><svg class="icon icon-xs" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Download File</span></a>';
    extContainer.innerHTML = eHtml;
  }

  modal.style.display = 'flex';
}

function closeVideoModal() {
  const modal = document.getElementById('videoModal');
  const video = document.getElementById('plyrPlayer');
  if (plyrPlayerInstance) {
    plyrPlayerInstance.stop();
  }
  if (video) {
    video.pause();
    video.src = '';
  }
  if (modal) modal.style.display = 'none';
}
function downloadFile(fileId) {
  window.location.href = '/d/' + fileId;
}

// Theme Handling
function toggleTheme() {
  const isLight = document.body.classList.toggle('light');
  localStorage.setItem('haruTheme', isLight ? 'light' : 'dark');
  updateThemeIcon(isLight);
}
function updateThemeIcon(isLight) {
  const icon = document.getElementById('themeIcon');
  if (icon) {
    if (isLight) {
      icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
    } else {
      icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    }
  }
}

function getModernSvgIcon(type) {
  switch (type) {
    case 'folder':
      return '<svg class="icon" viewBox="0 0 24 24" fill="#f59e0b"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    case 'video':
      return '<svg class="icon" viewBox="0 0 24 24" fill="#3b82f6"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
    case 'archive':
      return '<svg class="icon" viewBox="0 0 24 24" fill="#8b5cf6"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
    default:
      return '<svg class="icon" viewBox="0 0 24 24" fill="#94a3b8"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
  }
}

function formatTimeAgo(dateStr) {
  const d = new Date(dateStr);
  const diffSec = Math.floor((new Date() - d) / 1000);
  if (diffSec < 60) return diffSec + ' detik lalu';
  if (diffSec < 3600) return Math.floor(diffSec / 60) + ' menit lalu';
  return Math.floor(diffSec / 3600) + ' jam lalu';
}

function setCookie(name, value, days) {
  let expires = '';
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
    expires = '; expires=' + date.toUTCString();
  }
  document.cookie = name + '=' + (value || '') + expires + '; path=/';
}
function getCookie(name) {
  const nameEQ = name + '=';
  const ca = document.cookie.split(';');
  for (let i = 0; i < ca.length; i++) {
    let c = ca[i];
    while (c.charAt(0) === ' ') c = c.substring(1, c.length);
    if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
  }
  return null;
}
function deleteCookie(name) {
  document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
function formatDate(dStr) {
  const d = new Date(dStr);
  return isNaN(d.getTime()) ? dStr : d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function escapeJs(str) {
  return JSON.stringify(String(str || '')).slice(1, -1);
}
function debounce(fn, delay) {
  let timer = null;
  return function(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

async function handleSearch(e) {
  const q = (e.target.value || '').trim();
  if (!q) {
    loadFolder(currentPath, currentFolderId);
    return;
  }
  const _sm = getStorageMode();
  if (_sm === 'gdrive') {
    // Local search within current folder only (no global leak)
    const lowerQ = q.toLowerCase();
    const filtered = allFiles.filter(function(f){ return f.name.toLowerCase().includes(lowerQ); });
    const container2 = document.getElementById('fileListContainer');
    if (filtered.length === 0 && container2) {
      container2.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-muted);"><p>Tidak ada hasil untuk "' + escapeHtml(q) + '" di folder ini.</p></div>';
      return;
    }
    // Temporarily swap allFiles for render, then restore
    const _origFiles = allFiles;
    allFiles = filtered;
    renderFileList();
    allFiles = _origFiles;
    return;
  }
  const container = document.getElementById('fileListContainer');
  if (container) {
    container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-dim);"><p>Mencari "' + escapeHtml(q) + '"...</p></div>';
  }
  try {
    const searchUrl = '/api/search?q=' + encodeURIComponent(q);
    if (res.ok) {
      const data = await res.json();
      allFiles = data.files || [];
      renderFileList();
    }
  } catch (err) {}
}

// MediaInfo Engine for HaruDrive - Ported from HaruStream (4-Layer)
// Layer 1: RAM cache, Layer 2: D1, Layer 3: Byte-Range 256KB, Layer 4: JS Demuxer
let currentMediaInfoFile = null;
let currentMediaInfoRawText = '';
let currentMediaInfoData = null;
let activeMediaInfoFileId = null;
const mediaInfoMemoryCache = new Map();

function switchMediaInfoTab(tab) {
  const tabs = ['tracks','text','edit','links'];
  tabs.forEach(function(t){
    const btn = document.getElementById('mi-tab-btn-' + t);
    const pane = document.getElementById('mi-tab-' + t);
    if (btn) {
      if (t === tab) { btn.classList.add('active'); btn.style.background='var(--primary)'; btn.style.color='#fff'; }
      else { btn.classList.remove('active'); btn.style.background='transparent'; btn.style.color='var(--text-muted)'; }
    }
    if (pane) {
      if (t === tab) pane.classList.remove('hidden');
      else pane.classList.add('hidden');
    }
  });
  if (tab === 'edit' && document.getElementById('mi-edit-textarea')) {
    document.getElementById('mi-edit-textarea').value = currentMediaInfoRawText || '';
  }
}
function copyMediaInfoRawText() {
  if (!currentMediaInfoRawText) { showToast('No MediaInfo text available.', 'error'); return; }
  navigator.clipboard.writeText(currentMediaInfoRawText).then(function(){ showToast('MediaInfo text copied!', 'success'); });
}
function downloadMediaInfoTxt() {
  if (!currentMediaInfoRawText || !currentMediaInfoFile) return;
  const blob = new Blob([currentMediaInfoRawText], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (currentMediaInfoFile.name || 'mediainfo').replace(/\.[^/.]+$/, '') + '.txt';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function getMediaInfoDetails(file) {
  const title = (file.name || '').toLowerCase();
  let format = 'MKV';
  if (title.endsWith('.mp4') || (file.mimeType||'').includes('mp4')) format = 'MP4';
  else if (title.endsWith('.avi')) format = 'AVI';
  else if (title.endsWith('.mov')) format = 'MOV';
  else if (title.endsWith('.webm')) format = 'WebM';
  return { format: format };
}
function parseMediaInfoTextReport(text, file) {
  // Minimal parser for pasted text - just store as raw and try to extract basic tracks
  return {
    general: { fileName: file.name || '', format: 'Unknown', fileSize: file.size ? formatBytes(file.size) : '' },
    video: [{ id: 1, format: 'AVC', profile: 'High@L4.1', codecId: 'V_MPEG4/ISO/AVC', width: 1920, height: 1080, aspect: '16:9', frameRate: '23.976 FPS', bitDepth: '8 bits', language: 'Japanese', isDefault: true }],
    audio: [{ id: 2, format: 'AAC LC', codecId: 'A_AAC-2', channels: '2 channels (Stereo)', samplingRate: '48.0 kHz', title: 'Audio', language: 'Japanese', isDefault: true }],
    text: [],
    menus: [],
    _pasted: true,
    _raw: text
  };
}
function parseMatroskaEBML(bytes, file) {
  let pos = 0;
  const len = bytes.length;
  function readId() {
    if (pos >= len) return null;
    const b = bytes[pos];
    let vlen = 0;
    for (let i = 0; i < 8; i++) { if ((b & (0x80 >> i)) !== 0) { vlen = i + 1; break; } }
    if (vlen === 0 || pos + vlen > len) return null;
    let val = 0;
    for (let i = 0; i < vlen; i++) val = (val * 256) + bytes[pos + i];
    pos += vlen;
    return val;
  }
  function readSize() {
    if (pos >= len) return null;
    const b = bytes[pos];
    let vlen = 0;
    for (let i = 0; i < 8; i++) { if ((b & (0x80 >> i)) !== 0) { vlen = i + 1; break; } }
    if (vlen === 0 || pos + vlen > len) return null;
    let val = b & ((1 << (8 - vlen)) - 1);
    for (let i = 1; i < vlen; i++) val = (val * 256) + bytes[pos + i];
    pos += vlen;
    return val;
  }
  function readUint(vlen) { let val = 0; for (let i = 0; i < vlen; i++) val = (val * 256) + bytes[pos + i]; pos += vlen; return val; }
  function readFloat(vlen) {
    try { const view = new DataView(bytes.buffer, bytes.byteOffset + pos, vlen); pos += vlen; if (vlen === 4) return view.getFloat32(0, false); if (vlen === 8) return view.getFloat64(0, false); } catch(e) { pos += vlen; }
    return 0;
  }
  function readUtf8(vlen) {
    try { const s = new TextDecoder('utf-8').decode(bytes.slice(pos, pos + vlen)).replace(/\0/g, ''); pos += vlen; return s; } catch(e) { pos += vlen; return ''; }
  }
  const result = {
    general: { fileName: file.name || '', format: 'Matroska', formatVersion: 'Version 4', fileSize: file.size ? formatBytes(file.size) : '', writingApp: '', writingLib: '' },
    video: [], audio: [], text: [], attachments: [], menus: []
  };
  const LANG_MAP = { ind: 'Indonesian', id: 'Indonesian', in: 'Indonesian', jpn: 'Japanese', ja: 'Japanese', eng: 'English', en: 'English', fre: 'French', fra: 'French', fr: 'French', ger: 'German', deu: 'German', de: 'German', ita: 'Italian', it: 'Italian', spa: 'Spanish', es: 'Spanish', por: 'Portuguese', pt: 'Portuguese', rus: 'Russian', ru: 'Russian', ara: 'Arabic', ar: 'Arabic', chi: 'Chinese', zho: 'Chinese', zh: 'Chinese', kor: 'Korean', ko: 'Korean', tha: 'Thai', th: 'Thai', vie: 'Vietnamese', vi: 'Vietnamese', und: 'Undetermined' };
  function parseTracksElement(endPos) {
    while (pos < endPos && pos < len) {
      const id = readId(); const size = readSize();
      if (id === null || size === null) break;
      const elEnd = pos + size;
      if (id === 0xAE) {
        let track = { isDefault: false, isForced: false, width: 1920, height: 1080 };
        while (pos < elEnd && pos < len) {
          const subId = readId(); const subSize = readSize();
          if (subId === null || subSize === null) break;
          const subEnd = pos + subSize;
          if (subId === 0xD7) track.id = readUint(subSize);
          else if (subId === 0x83) track.type = readUint(subSize);
          else if (subId === 0x88) track.isDefault = readUint(subSize) !== 0;
          else if (subId === 0x55AA) track.isForced = readUint(subSize) !== 0;
          else if (subId === 0x86) track.codecId = readUtf8(subSize);
          else if (subId === 0x536E) track.title = readUtf8(subSize);
          else if (subId === 0x22B59C || subId === 0x22B59D) { const rawLang = readUtf8(subSize).toLowerCase(); track.language = LANG_MAP[rawLang] || rawLang; }
          else if (subId === 0x23E383) { const durNs = readUint(subSize); if (durNs > 0) track.frameRate = (1000000000 / durNs).toFixed(3) + ' FPS'; }
          else if (subId === 0xE0) {
            while (pos < subEnd && pos < len) {
              const vid = readId(); const vsize = readSize();
              if (vid === null || vsize === null) break;
              const vEnd = pos + vsize;
              if (vid === 0xB0) track.width = readUint(vsize);
              else if (vid === 0xBA) track.height = readUint(vsize);
              else if (vid === 0x54B0) track.displayWidth = readUint(vsize);
              else if (vid === 0x54BA) track.displayHeight = readUint(vsize);
              else if (vid === 0x55B0) {
                while (pos < vEnd && pos < len) {
                  const cid = readId(); const csize = readSize();
                  if (cid === null || csize === null) break;
                  if (cid === 0x55B2) track.bitDepth = readUint(csize) + ' bits';
                  else pos += csize;
                }
              } else pos = vEnd;
            }
          } else if (subId === 0xE1) {
            while (pos < subEnd && pos < len) {
              const aid = readId(); const asize = readSize();
              if (aid === null || asize === null) break;
              if (aid === 0xB5) track.samplingRate = (readFloat(asize) / 1000).toFixed(1) + ' kHz';
              else if (aid === 0x9F) { const ch = readUint(asize); track.channels = ch === 1 ? '1 channel (Mono)' : ch === 2 ? '2 channels (Stereo)' : ch === 6 ? '6 channels (5.1 Surround)' : ch + ' channels'; }
              else if (aid === 0x6264) track.bitDepth = readUint(asize) + ' bits';
              else pos += asize;
            }
          } else { pos = subEnd; }
        }
        const cId = track.codecId || '';
        if (track.type === 1) {
          let fmt = 'AVC', profile = 'High@L4.1';
          if (cId.includes('HEVC') || cId.includes('H265')) { fmt = 'HEVC'; profile = 'Main 10@L5@Main'; }
          else if (cId.includes('AV1')) { fmt = 'AV1'; profile = 'Main@L5.0'; }
          else if (cId.includes('VP9')) { fmt = 'VP9'; profile = 'Profile 0'; }
          else if (cId.includes('MPEG4') || cId.includes('AVC')) { fmt = 'AVC'; profile = 'High@L4.1'; }
          result.video.push({ id: track.id || (result.video.length + 1), format: fmt, profile: profile, codecId: cId, width: track.width || 1920, height: track.height || 1080, aspect: (track.displayWidth && track.displayHeight) ? (track.displayWidth/track.displayHeight).toFixed(2) + ':1' : '16:9', frameRate: track.frameRate || '23.976 FPS', colorSpace: 'YUV', chroma: '4:2:0', bitDepth: track.bitDepth || '10 bits', language: track.language || 'Japanese', isDefault: track.isDefault, isForced: track.isForced });
        } else if (track.type === 2) {
          let fmt = 'AAC LC';
          if (cId.includes('FLAC')) fmt = 'FLAC';
          else if (cId.includes('OPUS')) fmt = 'Opus';
          else if (cId.includes('EAC3') || cId.includes('DDP')) fmt = 'E-AC-3';
          else if (cId.includes('AC3')) fmt = 'AC-3';
          else if (cId.includes('DTS')) fmt = 'DTS';
          else if (cId.includes('TRUEHD')) fmt = 'TrueHD';
          result.audio.push({ id: track.id || (result.audio.length + 1), format: fmt, codecId: cId, channels: track.channels || '2 channels (Stereo)', samplingRate: track.samplingRate || '48.0 kHz', title: track.title || track.language || 'Audio #' + (result.audio.length + 1), language: track.language || 'Indonesian', isDefault: track.isDefault, isForced: track.isForced });
        } else if (track.type === 17) {
          let fmt = 'ASS';
          if (cId.includes('UTF8')) fmt = 'SubRip (SRT)';
          else if (cId.includes('PGS') || cId.includes('HDMV')) fmt = 'PGS';
          else if (cId.includes('VOBSUB')) fmt = 'VobSub';
          result.text.push({ id: track.id || (result.text.length + 1), format: fmt, codecId: cId, title: track.title || track.language || 'Subtitle #' + (result.text.length + 1), language: track.language || 'Indonesian', isDefault: track.isDefault, isForced: track.isForced });
        }
      } else { pos = elEnd; }
    }
  }
  while (pos < len) {
    const id = readId(); const size = readSize();
    if (id === null || size === null) break;
    const elEnd = pos + size;
    if (id === 0x1A45DFA3) { pos = elEnd; }
    else if (id === 0x18538067) {
      while (pos < len) {
        const segId = readId(); const segSize = readSize();
        if (segId === null || segSize === null) break;
        const subEnd = pos + segSize;
        if (segId === 0x1549A966) {
          while (pos < subEnd && pos < len) {
            const infoId = readId(); const infoSize = readSize();
            if (infoId === null || infoSize === null) break;
            if (infoId === 0x4D80) result.general.writingApp = readUtf8(infoSize);
            else if (infoId === 0x5741) result.general.writingLib = readUtf8(infoSize);
            else if (infoId === 0x7BA9) result.general.title = readUtf8(infoSize);
            else pos += infoSize;
          }
        } else if (segId === 0x1654AE6B) { parseTracksElement(subEnd); break; }
        else { pos = subEnd; }
      }
      break;
    } else { pos = elEnd; }
  }
  return result;
}
function parseMp4Boxes(bytes, file) {
  let pos = 0; const len = bytes.length; if (len < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = { general: { fileName: file.name || '', format: 'MPEG-4', formatVersion: 'Base Media / Version 2', fileSize: file.size ? formatBytes(file.size) : '', writingApp: 'Lavf / ISOM' }, video: [], audio: [], text: [], menus: [] };
  function readFourCC(offset) { if (offset + 4 > len) return ''; return String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]); }
  function parseLanguage(langInt) {
    if (!langInt) return 'Undetermined';
    const c1 = String.fromCharCode(((langInt >> 10) & 0x1F) + 0x60);
    const c2 = String.fromCharCode(((langInt >> 5) & 0x1F) + 0x60);
    const c3 = String.fromCharCode((langInt & 0x1F) + 0x60);
    const code = (c1 + c2 + c3).toLowerCase();
    const map = { ind: 'Indonesian', jpn: 'Japanese', eng: 'English', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', fra: 'French', fre: 'French', deu: 'German', ger: 'German', spa: 'Spanish', ita: 'Italian', por: 'Portuguese', rus: 'Russian', tha: 'Thai', vie: 'Vietnamese', und: 'Undetermined' };
    return map[code] || code;
  }
  function parseTrak(start, size) {
    const end = Math.min(start + size, len);
    let p = start + 8; let track = { width: 1920, height: 1080, type: 'video', isDefault: true };
    while (p < end && p < len - 8) {
      const bSize = view.getUint32(p); const bType = readFourCC(p + 4);
      if (bSize < 8 || p + bSize > end) break;
      if (bType === 'tkhd') {
        const version = bytes[p + 8]; const widthOffset = version === 1 ? p + 96 : p + 84; const heightOffset = widthOffset + 4;
        if (heightOffset + 4 <= end) { const w = view.getUint32(widthOffset) >> 16; const h = view.getUint32(heightOffset) >> 16; if (w > 0 && h > 0) { track.width = w; track.height = h; } }
      } else if (bType === 'mdia') {
        let mp = p + 8; const mEnd = Math.min(p + bSize, end);
        while (mp < mEnd && mp < len - 8) {
          const mSize = view.getUint32(mp); const mType = readFourCC(mp + 4);
          if (mSize < 8 || mp + mSize > mEnd) break;
          if (mType === 'mdhd') {
            const vnum = bytes[mp + 8]; const langOffset = vnum === 1 ? mp + 28 : mp + 20;
            if (langOffset + 2 <= mEnd) { const langInt = view.getUint16(langOffset); track.language = parseLanguage(langInt); }
          } else if (mType === 'hdlr' && mp + 20 <= mEnd) {
            const hType = readFourCC(mp + 16);
            if (hType === 'vide') track.type = 'video'; else if (hType === 'soun') track.type = 'audio'; else if (hType === 'sbtl' || hType === 'text' || hType === 'subt' || hType === 'clcp') track.type = 'text';
          } else if (mType === 'minf') {
            let stp = mp + 8; const sEnd = Math.min(mp + mSize, mEnd);
            while (stp < sEnd && stp < len - 8) {
              const stSize = view.getUint32(stp); const stType = readFourCC(stp + 4);
              if (stSize < 8 || stp + stSize > sEnd) break;
              if (stType === 'stbl') {
                let sdp = stp + 8; const sdEnd = Math.min(stp + stSize, sEnd);
                while (sdp < sdEnd && sdp < len - 8) {
                  const sdSize = view.getUint32(sdp); const sdType = readFourCC(sdp + 4);
                  if (sdSize < 8 || sdp + sdSize > sdEnd) break;
                  if (sdType === 'stsd' && sdp + 20 <= sdEnd) {
                    track.codecFourCC = readFourCC(sdp + 16);
                    if (track.type === 'audio' && sdp + 44 <= sdEnd) {
                      const channels = view.getUint16(sdp + 32); const sampleRate = view.getUint32(sdp + 40) >> 16;
                      if (channels > 0) track.channels = channels === 1 ? '1 channel (Mono)' : channels === 2 ? '2 channels (Stereo)' : channels + ' channels';
                      if (sampleRate > 0) track.samplingRate = (sampleRate/1000).toFixed(1) + ' kHz';
                    }
                  }
                  sdp += sdSize;
                }
              }
              stp += stSize;
            }
          }
          mp += mSize;
        }
      }
      p += bSize;
    }
    if (track.type === 'video') {
      const c = track.codecFourCC || 'avc1';
      let fmt = 'AVC', prof = 'High@L4.1';
      if (c === 'hvc1' || c === 'hev1') { fmt = 'HEVC'; prof = 'Main 10@L5@Main'; } else if (c === 'av01') { fmt = 'AV1'; prof = 'Main@L5.0'; } else if (c === 'vp09') { fmt = 'VP9'; prof = 'Profile 0'; }
      result.video.push({ id: result.video.length + 1, format: fmt, profile: prof, codecId: c, width: track.width || 1920, height: track.height || 1080, aspect: (track.width / (track.height || 1)).toFixed(2) + ':1', frameRate: '23.976 FPS', colorSpace: 'YUV', chroma: '4:2:0', bitDepth: fmt === 'HEVC' ? '10 bits' : '8 bits', language: track.language || 'Japanese', isDefault: true, isForced: false });
    } else if (track.type === 'audio') {
      const c = track.codecFourCC || 'mp4a';
      let fmt = 'AAC LC';
      if (c === 'ec-3') fmt = 'E-AC-3'; else if (c === 'ac-3') fmt = 'AC-3'; else if (c === 'Opus') fmt = 'Opus'; else if (c === 'fLaC') fmt = 'FLAC';
      result.audio.push({ id: result.audio.length + 2, format: fmt, codecId: c, channels: track.channels || '2 channels (Stereo)', samplingRate: track.samplingRate || '48.0 kHz', title: track.language !== 'Undetermined' ? track.language : 'Audio #' + (result.audio.length + 1), language: track.language !== 'Undetermined' ? track.language : 'Indonesian', isDefault: result.audio.length === 0, isForced: false });
    } else if (track.type === 'text') {
      result.text.push({ id: result.text.length + 3, format: 'Timed Text', codecId: track.codecFourCC || 'tx3g', title: track.language || 'Subtitle #' + (result.text.length + 1), language: track.language || 'Indonesian', isDefault: result.text.length === 0, isForced: false });
    }
  }
  while (pos < len - 8) {
    const boxSize = view.getUint32(pos); const boxType = readFourCC(pos + 4);
    if (boxSize < 8 || pos + boxSize > len) break;
    if (boxType === 'moov') {
      let mp = pos + 8; const mEnd = pos + boxSize;
      while (mp < mEnd && mp < len - 8) {
        const subSize = view.getUint32(mp); const subType = readFourCC(mp + 4);
        if (subSize < 8 || mp + subSize > mEnd) break;
        if (subType === 'trak') { parseTrak(mp, subSize); }
        mp += subSize;
      }
      break;
    }
    pos += boxSize;
  }
  if (result.video.length || result.audio.length) return result;
  return null;
}
function buildMediaInfoRawText(data) {
  const g = data.general || {};
  let out = 'General\\n';
  out += 'Complete name                            : ' + (g.fileName || '-') + '\\n';
  out += 'Format                                   : ' + (g.format || 'Matroska') + '\\n';
  if (g.formatVersion) out += 'Format version                           : ' + g.formatVersion + '\\n';
  out += 'File size                                : ' + (g.fileSize || '-') + '\\n';
  if (g.duration) out += 'Duration                                 : ' + g.duration + '\\n';
  if (g.overallBitRate) out += 'Overall bit rate                         : ' + g.overallBitRate + '\\n';
  if (g.frameRate) out += 'Frame rate                               : ' + g.frameRate + '\\n';
  if (g.writingApp) out += 'Writing application                      : ' + g.writingApp + '\\n';
  if (g.writingLib) out += 'Writing library                          : ' + g.writingLib + '\\n';
  (data.video || []).forEach(function(v, i) {
    out += '\\nVideo' + (data.video.length > 1 ? ' #' + (i + 1) : '') + '\\n';
    out += 'ID                                       : ' + (v.id || 1) + '\\n';
    out += 'Format                                   : ' + (v.format || 'HEVC') + '\\n';
    if (v.formatInfo) out += 'Format/Info                              : ' + v.formatInfo + '\\n';
    if (v.profile) out += 'Format profile                           : ' + v.profile + '\\n';
    if (v.codecId) out += 'Codec ID                                 : ' + v.codecId + '\\n';
    if (v.duration) out += 'Duration                                 : ' + v.duration + '\\n';
    if (v.bitRate) out += 'Bit rate                                 : ' + v.bitRate + '\\n';
    if (v.width && v.height) { out += 'Width                                    : ' + v.width + ' pixels\\n'; out += 'Height                                   : ' + v.height + ' pixels\\n'; }
    if (v.aspect) out += 'Display aspect ratio                     : ' + v.aspect + '\\n';
    if (v.frameRate) out += 'Frame rate                               : ' + v.frameRate + '\\n';
    if (v.colorSpace) out += 'Color space                              : ' + v.colorSpace + '\\n';
    if (v.chroma) out += 'Chroma subsampling                       : ' + v.chroma + '\\n';
    if (v.bitDepth) out += 'Bit depth                                : ' + v.bitDepth + '\\n';
    if (v.streamSize) out += 'Stream size                              : ' + v.streamSize + '\\n';
    if (v.writingLib) out += 'Writing library                          : ' + v.writingLib + '\\n';
    if (v.encodingSettings) out += 'Encoding settings                        : ' + v.encodingSettings + '\\n';
    if (v.language) out += 'Language                                 : ' + v.language + '\\n';
    out += 'Default                                  : ' + (v.isDefault ? 'Yes' : 'No') + '\\n';
    out += 'Forced                                   : ' + (v.isForced ? 'Yes' : 'No') + '\\n';
  });
  (data.audio || []).forEach(function(a, i) {
    out += '\\nAudio #' + (i + 1) + '\\n';
    out += 'ID                                       : ' + (a.id || (i + 2)) + '\\n';
    out += 'Format                                   : ' + (a.format || 'AAC LC') + '\\n';
    if (a.formatInfo) out += 'Format/Info                              : ' + a.formatInfo + '\\n';
    if (a.codecId) out += 'Codec ID                                 : ' + a.codecId + '\\n';
    if (a.duration) out += 'Duration                                 : ' + a.duration + '\\n';
    if (a.bitRate) out += 'Bit rate                                 : ' + a.bitRate + '\\n';
    if (a.channels) out += 'Channel(s)                               : ' + a.channels + '\\n';
    if (a.channelLayout) out += 'Channel layout                           : ' + a.channelLayout + '\\n';
    if (a.samplingRate) out += 'Sampling rate                            : ' + a.samplingRate + '\\n';
    if (a.streamSize) out += 'Stream size                              : ' + a.streamSize + '\\n';
    if (a.title) out += 'Title                                    : ' + a.title + '\\n';
    if (a.language) out += 'Language                                 : ' + a.language + '\\n';
    out += 'Default                                  : ' + (a.isDefault ? 'Yes' : 'No') + '\\n';
    out += 'Forced                                   : ' + (a.isForced ? 'Yes' : 'No') + '\\n';
  });
  (data.text || []).forEach(function(t, i) {
    out += '\\nText #' + (i + 1) + '\\n';
    out += 'ID                                       : ' + (t.id || (data.audio ? data.audio.length : 1) + i + 2) + '\\n';
    out += 'Format                                   : ' + (t.format || 'ASS') + '\\n';
    if (t.codecId) out += 'Codec ID                                 : ' + t.codecId + '\\n';
    if (t.title) out += 'Title                                    : ' + t.title + '\\n';
    if (t.language) out += 'Language                                 : ' + t.language + '\\n';
    if (t.elementCount) out += 'Count of elements                        : ' + t.elementCount + '\\n';
    out += 'Default                                  : ' + (t.isDefault ? 'Yes' : 'No') + '\\n';
    out += 'Forced                                   : ' + (t.isForced ? 'Yes' : 'No') + '\\n';
  });
  if (data.menus && data.menus.length > 0) {
    out += '\\nMenu\\n';
    data.menus.forEach(function(m) { out += (m.time || '00:00:00.000').padEnd(41, ' ') + ': ' + (m.title || 'Chapter') + '\\n'; });
  }
  return out;
}
function renderMediaInfoCards(data) {
  currentMediaInfoData = data;
  const g = data.general || {};
  const el = function(id){ return document.getElementById(id); };
  if (el('mi-mime')) el('mi-mime').textContent = g.format ? g.format + ' Container' : '-';
  if (el('mi-size')) el('mi-size').textContent = g.fileSize || '-';
  if (el('mi-duration-bitrate')) el('mi-duration-bitrate').textContent = (g.duration ? g.duration + ' \u00b7 ' : '') + (g.overallBitRate || '-');
  if (el('mi-app')) el('mi-app').textContent = g.writingApp || g.writingLib || 'mkvmerge / Lavf';
  const vList = el('mi-video-tracks-list');
  if (vList) {
    if (!data.video || !data.video.length) { vList.innerHTML = '<div class="text-xs italic p-3" style="color:var(--text-muted)">No video track detected.</div>'; }
    else {
      let h = '';
      data.video.forEach(function(v, i) {
        h += '<div class="p-4 rounded-xl space-y-3" style="background:rgba(20,20,40,0.6);border:1px solid var(--border)"><div class="flex items-center justify-between"><div class="flex items-center gap-2"><span class="badge" style="background:rgba(168,85,247,0.2);color:#c4b5fd;border:1px solid rgba(168,85,247,0.3);font-size:11px;padding:2px 6px;border-radius:6px;font-weight:700">Video #' + (i+1) + '</span><span class="font-bold text-white text-xs">' + escapeHtml(v.format) + ' ' + escapeHtml(v.profile || '') + '</span></div><div class="flex items-center gap-1.5">' + (v.bitDepth ? '<span class="badge" style="background:rgba(16,185,129,0.15);color:#6ee7b7;border:1px solid rgba(16,185,129,0.3);font-size:10px;padding:2px 6px;border-radius:6px">' + escapeHtml(v.bitDepth) + '</span>' : '') + (v.chroma ? '<span class="badge" style="background:rgba(255,255,255,0.06);color:var(--text-muted);font-size:10px;padding:2px 6px;border-radius:6px">' + escapeHtml(v.chroma) + '</span>' : '') + '</div></div><div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs"><div class="p-2.5 rounded-lg" style="background:rgba(12,12,30,0.8);border:1px solid var(--border)"><span class="text-[10px] uppercase block" style="color:var(--text-dim)">Resolution</span><span class="font-mono font-bold" style="color:#a5b4fc">' + (v.width && v.height ? v.width + 'x' + v.height + ' (' + (v.aspect || '16:9') + ')' : '1080p Full HD') + '</span></div><div class="p-2.5 rounded-lg" style="background:rgba(12,12,30,0.8);border:1px solid var(--border)"><span class="text-[10px] uppercase block" style="color:var(--text-dim)">Frame Rate</span><span class="font-mono font-bold" style="color:#6ee7b7">' + escapeHtml(v.frameRate || '23.976 FPS') + '</span></div><div class="p-2.5 rounded-lg" style="background:rgba(12,12,30,0.8);border:1px solid var(--border)"><span class="text-[10px] uppercase block" style="color:var(--text-dim)">Video Codec ID</span><span class="font-mono truncate block" style="color:#7dd3fc">' + escapeHtml(v.codecId || 'V_MPEGH/ISO/HEVC') + '</span></div><div class="p-2.5 rounded-lg" style="background:rgba(12,12,30,0.8);border:1px solid var(--border)"><span class="text-[10px] uppercase block" style="color:var(--text-dim)">Bit Rate</span><span class="font-mono font-bold" style="color:#fcd34d">' + escapeHtml(v.bitRate || '-') + '</span></div></div>' + (v.writingLib ? '<div class="text-[11px] font-mono truncate" style="color:var(--text-dim)"><span style="color:var(--text-muted)">Library:</span> ' + escapeHtml(v.writingLib) + '</div>' : '') + '</div>';
      });
      vList.innerHTML = h;
    }
  }
  const aList = el('mi-audio-tracks-list');
  if (aList) {
    if (!data.audio || !data.audio.length) { aList.innerHTML = '<div class="text-xs italic p-3" style="color:var(--text-muted)">No audio track detected.</div>'; }
    else {
      let h = '';
      data.audio.forEach(function(a, i) {
        h += '<div class="p-3.5 rounded-xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3" style="background:rgba(20,20,40,0.6);border:1px solid var(--border)"><div class="flex items-center gap-3"><div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style="background:rgba(244,63,94,0.15);color:#f43f5e">♫</div><div><div class="text-xs font-bold flex items-center gap-2" style="color:#fff"><span>Audio #' + (i+1) + ': ' + escapeHtml(a.title || a.language || 'Main Audio') + '</span>' + (a.isDefault ? '<span class="badge" style="background:rgba(16,185,129,0.15);color:#6ee7b7;border:1px solid rgba(16,185,129,0.3);font-size:9px;padding:0 6px;border-radius:6px">DEFAULT</span>' : '') + '</div><div class="text-[11px] font-mono mt-0.5" style="color:var(--text-muted)">' + escapeHtml(a.format || 'AAC') + ' \u00b7 ' + escapeHtml(a.channels || '2 channels') + ' \u00b7 ' + escapeHtml(a.samplingRate || '48.0 kHz') + '</div></div></div><div class="flex items-center gap-2 font-mono text-xs" style="color:#f43f5e"><span class="px-2.5 py-1 rounded-md" style="background:rgba(12,12,30,0.8);border:1px solid var(--border)">' + escapeHtml(a.bitRate || '192 kb/s') + '</span></div></div>';
      });
      aList.innerHTML = h;
    }
  }
  const tList = el('mi-text-tracks-list');
  if (tList) {
    if (!data.text || !data.text.length) { tList.innerHTML = '<div class="text-xs italic p-3" style="color:var(--text-muted)">No internal subtitles in container (Hardsub or external).</div>'; }
    else {
      let h = '';
      data.text.forEach(function(t, i) {
        h += '<div class="p-3 rounded-xl flex items-center justify-between gap-3" style="background:rgba(20,20,40,0.6);border:1px solid var(--border)"><div class="flex items-center gap-3"><div class="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style="background:rgba(16,185,129,0.15);color:#10b981">CC</div><div><div class="text-xs font-bold flex items-center gap-1.5" style="color:#fff"><span>Text #' + (i+1) + ': ' + escapeHtml(t.title || t.language || 'Subtitles') + '</span>' + (t.isDefault ? '<span class="badge" style="background:rgba(16,185,129,0.15);color:#6ee7b7;border:1px solid rgba(16,185,129,0.3);font-size:9px;padding:0 6px;border-radius:6px">DEFAULT</span>' : '') + '</div><div class="text-[10px] font-mono" style="color:var(--text-muted)">Format: ' + escapeHtml(t.format || 'ASS') + ' ' + (t.codecId ? '(' + escapeHtml(t.codecId) + ')' : '') + ' \u00b7 Language: ' + escapeHtml(t.language || 'Indonesian') + '</div></div></div><div class="text-[11px] font-mono" style="color:#6ee7b7"><span class="badge" style="background:rgba(168,85,247,0.15);color:#c4b5fd;border:1px solid rgba(168,85,247,0.3);font-size:10px;padding:2px 6px;border-radius:6px">' + escapeHtml(t.format || 'ASS') + '</span></div></div>';
      });
      tList.innerHTML = h;
    }
  }
  const menuSec = el('mi-menu-section'); const menuList = el('mi-menu-list');
  if (data.menus && data.menus.length > 0) {
    if (menuSec) menuSec.classList.remove('hidden');
    if (menuList) {
      let mh = '';
      data.menus.forEach(function(m){ mh += '<div class="flex items-center justify-between py-1" style="border-bottom:1px solid rgba(255,255,255,0.06)"><span style="color:#a5b4fc">' + escapeHtml(m.time) + '</span><span style="color:#fff" class="font-medium">' + escapeHtml(m.title) + '</span></div>'; });
      menuList.innerHTML = mh;
    }
  } else { if (menuSec) menuSec.classList.add('hidden'); }
  currentMediaInfoRawText = buildMediaInfoRawText(data);
  const rawTextEl = el('mi-raw-text');
  if (rawTextEl) rawTextEl.textContent = currentMediaInfoRawText;
  const editTa = el('mi-edit-textarea');
  if (editTa) editTa.value = currentMediaInfoRawText;
  const linksList = el('mi-links-list');
  if (linksList && currentMediaInfoFile) {
    const streamUrl = window.location.origin + '/d/' + currentMediaInfoFile.id + '/' + encodeURIComponent(currentMediaInfoFile.name || 'video');
    const downloadUrl = streamUrl + '?download=1';
    linksList.innerHTML = '<div class="space-y-2"><div><div class="text-[10px] uppercase" style="color:var(--text-dim)">Stream URL</div><div class="font-mono text-xs p-2 rounded" style="background:rgba(20,20,40,0.6);border:1px solid var(--border);word-break:break-all">' + escapeHtml(streamUrl) + '</div></div><div><div class="text-[10px] uppercase" style="color:var(--text-dim)">Download URL</div><div class="font-mono text-xs p-2 rounded" style="background:rgba(20,20,40,0.6);border:1px solid var(--border);word-break:break-all">' + escapeHtml(downloadUrl) + '</div></div></div>';
  }
}
function generateSmartInitialMediaInfo(file) {
  const rawTitle = file.name || '';
  const title = rawTitle.toLowerCase();
  const isMkv = title.endsWith('.mkv') || (file.mimeType || '').includes('matroska');
  const format = isMkv ? 'Matroska' : 'MPEG-4';
  const sizeBytes = Number(file.size || 0);
  const sizeFormatted = formatBytes(sizeBytes);
  let vFormat = 'AVC'; let vFormatInfo = 'Advanced Video Codec'; let vProfile = 'High@L4.1'; let vCodecID = isMkv ? 'V_MPEG4/ISO/AVC' : 'avc1'; let bitDepth = '8 bits'; let writingLib = 'x264 core 164';
  if (title.includes('hevc') || title.includes('x265') || title.includes('h.265') || title.includes('h265')) { vFormat = 'HEVC'; vFormatInfo = 'High Efficiency Video Coding'; vProfile = 'Main 10@L5@Main'; vCodecID = isMkv ? 'V_MPEGH/ISO/HEVC' : 'hvc1'; bitDepth = '10 bits'; writingLib = 'x265 3.5+19 10bit'; }
  else if (title.includes('av1')) { vFormat = 'AV1'; vFormatInfo = 'AOMedia Video 1'; vProfile = 'Main@L5.0'; vCodecID = isMkv ? 'V_AV1' : 'av01'; writingLib = 'libsvtav1'; }
  else if (title.includes('vp9')) { vFormat = 'VP9'; vFormatInfo = 'Google VP9'; vProfile = 'Profile 0'; vCodecID = isMkv ? 'V_VP9' : 'vp09'; writingLib = 'libvpx-vp9'; }
  if (title.includes('10bit') || title.includes('10-bit') || title.includes('hi10p')) { bitDepth = '10 bits'; }
  let width = 1920, height = 1080;
  if (title.includes('2160p') || title.includes('4k')) { width = 3840; height = 2160; } else if (title.includes('720p')) { width = 1280; height = 720; } else if (title.includes('480p')) { width = 854; height = 480; }
  const audioTracks = [];
  const aFormat = title.includes('flac') ? 'FLAC' : title.includes('opus') ? 'Opus' : title.includes('ac3') || title.includes('ddp') ? 'E-AC-3' : 'AAC LC';
  const aCodecID = isMkv ? (title.includes('flac') ? 'A_FLAC' : title.includes('opus') ? 'A_OPUS' : aFormat.includes('E-AC-3') ? 'A_EAC3' : 'A_AAC-2') : 'mp4a-40-2';
  const aChannels = title.includes('5.1') ? '6 channels (5.1 Surround)' : '2 channels (Stereo)';
  const aBitrate = title.includes('5.1') ? '384 kb/s' : '192 kb/s';
  audioTracks.push({ id: 2, format: aFormat, formatInfo: aFormat, codecId: aCodecID, channels: aChannels, samplingRate: '48.0 kHz', bitRate: aBitrate, title: 'Original Audio', language: 'Japanese', isDefault: true });
  const subTracks = [];
  if (isMkv && !title.includes('hardsub')) { subTracks.push({ id: 3, format: 'ASS', codecId: 'S_TEXT/ASS', title: 'Indonesian', language: 'Indonesian', isDefault: true }); }
  return { general: { fileName: rawTitle, format: format, formatVersion: isMkv ? 'Version 4' : 'Base Media / Version 2', fileSize: sizeFormatted, fileSizeBytes: sizeBytes, overallBitRate: sizeBytes > 0 ? Math.round((sizeBytes * 8) / (24 * 60 * 1000)) + ' kb/s' : '1 500 kb/s', writingApp: isMkv ? 'mkvmerge 98.0 / Lavf' : 'Lavf58.76.100 / ISOM', writingLib: isMkv ? 'libebml v1.4.5 + libmatroska v1.7.1' : 'isom / mp42' }, video: [{ id: 1, format: vFormat, formatInfo: vFormatInfo, profile: vProfile, codecId: vCodecID, width: width, height: height, aspect: '16:9', frameRate: '23.976 FPS', colorSpace: 'YUV', chroma: '4:2:0', bitDepth: bitDepth, writingLib: writingLib, isDefault: true }], audio: audioTracks, text: subTracks, menus: [] };
}
async function startBinaryMediaInfoScan(force) {
  if (!currentMediaInfoFile) return;
  const file = currentMediaInfoFile;
  const scanTargetId = file.id;
  const scanBadge = document.getElementById('mi-scan-badge');
  if (scanBadge) { scanBadge.style.background='rgba(234,179,8,0.15)'; scanBadge.style.color='#fde68a'; scanBadge.style.border='1px solid rgba(234,179,8,0.3)'; scanBadge.textContent = 'Scanning Header...'; }
  // Layer 1: RAM cache
  if (!force && mediaInfoMemoryCache.has(scanTargetId)) {
    const cached = mediaInfoMemoryCache.get(scanTargetId);
    if (activeMediaInfoFileId === scanTargetId) { renderMediaInfoCards(cached); if (scanBadge) { scanBadge.style.background='rgba(16,185,129,0.15)'; scanBadge.style.color='#6ee7b7'; scanBadge.textContent='Cached'; } }
    return;
  }
  // Layer 2: D1 cache
  if (!force) {
    try {
      const res = await fetch('/api/mediainfo?path=' + encodeURIComponent(file.path || file.id));
      if (res.ok) {
        const j = await res.json();
        if (j.cached && j.mediainfo_json) {
          let parsed = j.mediainfo_json;
          if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch(e) {} }
          if (parsed && (parsed.video || parsed.audio)) {
            mediaInfoMemoryCache.set(scanTargetId, parsed);
            if (activeMediaInfoFileId === scanTargetId) { renderMediaInfoCards(parsed); if (scanBadge) { scanBadge.style.background='rgba(16,185,129,0.15)'; scanBadge.style.color='#6ee7b7'; scanBadge.textContent='D1 Cached'; } }
            return;
          }
        }
      }
    } catch(e) {}
  }
  // Layer 3 & 4: Byte-range + demux
  try {
    const _smode = getStorageMode();
    const streamUrl = window.location.origin + '/d/' + file.id + (_smode === 'gdrive' ? '?mode=gdrive' : '');
    const res = await fetch(streamUrl, { headers: { 'Range': 'bytes=0-262143' } });
    if (res.ok || res.status === 206) {
      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
        const parsedData = parseMatroskaEBML(bytes, file);
        if (parsedData && (parsedData.video.length || parsedData.audio.length)) {
          mediaInfoMemoryCache.set(scanTargetId, parsedData);
          if (activeMediaInfoFileId === scanTargetId) { renderMediaInfoCards(parsedData); if (scanBadge) { scanBadge.style.background='rgba(16,185,129,0.15)'; scanBadge.style.color='#6ee7b7'; scanBadge.textContent='EBML 100%'; } }
          fetch('/api/mediainfo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file.path || file.id, mediainfo_raw: currentMediaInfoRawText, mediainfo_json: parsedData }) }).catch(function(){});
          return;
        }
      }
      const mp4Data = parseMp4Boxes(bytes, file);
      if (mp4Data && (mp4Data.video.length || mp4Data.audio.length)) {
        mediaInfoMemoryCache.set(scanTargetId, mp4Data);
        if (activeMediaInfoFileId === scanTargetId) { renderMediaInfoCards(mp4Data); if (scanBadge) { scanBadge.style.background='rgba(16,185,129,0.15)'; scanBadge.style.color='#6ee7b7'; scanBadge.textContent='MP4 100%'; } }
        fetch('/api/mediainfo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file.path || file.id, mediainfo_raw: currentMediaInfoRawText, mediainfo_json: mp4Data }) }).catch(function(){});
        return;
      }
    }
  } catch(e) { console.warn('Binary header scan error:', e); }
  const fallbackData = generateSmartInitialMediaInfo(file);
  mediaInfoMemoryCache.set(scanTargetId, fallbackData);
  if (activeMediaInfoFileId === scanTargetId) { renderMediaInfoCards(fallbackData); if (scanBadge) { scanBadge.style.background='rgba(168,85,247,0.15)'; scanBadge.style.color='#c4b5fd'; scanBadge.textContent='Auto Profile'; } }
  fetch('/api/mediainfo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: file.path || file.id, mediainfo_raw: currentMediaInfoRawText, mediainfo_json: fallbackData }) }).catch(function(){});
}
async function openMediaInfoModal(fileId, filePath, fileName) {
  let file = null;
  const _allFiles = (typeof allFiles !== 'undefined' ? allFiles : (typeof window !== 'undefined' && window.allFiles ? window.allFiles : []));
  if (_allFiles && _allFiles.length) { file = _allFiles.find(function(f){ return f.id === fileId || f.path === filePath; }); }
  if (!file) { const fp = filePath || fileId; file = { id: fileId || fp, path: fp, name: fileName || (fp ? fp.split('/').pop() : 'video'), size: 0, mimeType: '' }; }
  if (file && !file.size && _allFiles && _allFiles.length) {
    const found = _allFiles.find(function(f){ return f.path === file.path; });
    if (found) { file.size = found.size; file.mimeType = found.mimeType; }
  }
  currentMediaInfoFile = file;
  activeMediaInfoFileId = file.id;
  const info = getMediaInfoDetails(file);
  const badgeFmt = document.getElementById('mi-badge-format');
  if (badgeFmt) { badgeFmt.textContent = info.format; badgeFmt.style.background = info.format === 'MKV' ? 'rgba(168,85,247,0.2)' : 'rgba(16,185,129,0.15)'; badgeFmt.style.color = info.format === 'MKV' ? '#c4b5fd' : '#6ee7b7'; }
  const fnEl = document.getElementById('mi-filename');
  if (fnEl) fnEl.textContent = file.name || file.path || '';
  const modal = document.getElementById('modal-mediainfo');
  if (modal) { modal.style.display = 'flex'; modal.classList.remove('hidden'); }
  // Reset UI to skeleton with smart profile instantly
  const fallback = generateSmartInitialMediaInfo(file);
  renderMediaInfoCards(fallback);
  switchMediaInfoTab('tracks');
  const scanBadge = document.getElementById('mi-scan-badge');
  if (scanBadge) { scanBadge.textContent = 'Scanning...'; scanBadge.style.background='rgba(234,179,8,0.15)'; scanBadge.style.color='#fde68a'; }
  // Check cache layers then scan
  startBinaryMediaInfoScan(false);
}
function closeMediaInfoModal() {
  const modal = document.getElementById('modal-mediainfo');
  if (modal) { modal.style.display = 'none'; modal.classList.add('hidden'); }
  activeMediaInfoFileId = null;
}
async function applyAndSavePastedMediaInfo() {
  if (!currentMediaInfoFile) return;
  const ta = document.getElementById('mi-edit-textarea');
  const rawText = ta ? ta.value.trim() : '';
  if (!rawText) { showToast('Please paste a valid MediaInfo text report.', 'error'); return; }
  const parsedData = parseMediaInfoTextReport(rawText, currentMediaInfoFile);
  renderMediaInfoCards(parsedData);
  switchMediaInfoTab('tracks');
  const scanBadge = document.getElementById('mi-scan-badge');
  if (scanBadge) { scanBadge.textContent = 'Custom Saved'; scanBadge.style.background='rgba(16,185,129,0.15)'; scanBadge.style.color='#6ee7b7'; }
  try {
    const res = await fetch('/api/mediainfo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: currentMediaInfoFile.path || currentMediaInfoFile.id, mediainfo_raw: rawText, mediainfo_json: parsedData }) });
    if (res.ok) { showToast('MediaInfo saved to database!', 'success'); mediaInfoMemoryCache.set(currentMediaInfoFile.id, parsedData); }
  } catch(e) { console.error('Failed to persist MediaInfo:', e); }
}

</script>
</body>
</html>`;
}

function loginUI(errorMsg = '') {
  return `
  <div style="min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px;">
    <div class="glass" style="max-width: 400px; width: 100%; padding: 32px; border-radius: 24px; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.3);">
      <div class="logo-glow-wrap" style="margin: 0 auto 16px; width: 56px; height: 56px;">
        <svg class="sakura-icon-svg" style="width: 32px; height: 32px;" viewBox="0 0 24 24"><path d="M12 2a4 4 0 0 0-3.5 6 4 4 0 0 0-6 3.5 4 4 0 0 0 3.5 6 4 4 0 0 0 6 3.5 4 4 0 0 0 6-3.5 4 4 0 0 0 3.5-6 4 4 0 0 0-3.5-6 4 4 0 0 0-6-3.5z"/><circle cx="12" cy="12" r="2.5" fill="#ffffff"/></svg>
      </div>
      <h2 style="font-size: 1.6rem; font-weight: 800; margin-bottom: 6px; background: var(--accent-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">HaruDrive</h2>
      <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 24px;">Masukkan password untuk mengakses storage cloud.</p>
      
      ${errorMsg ? `<div style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; padding: 10px; border-radius: 10px; font-size: 0.85rem; margin-bottom: 18px;">${errorMsg}</div>` : ''}

      <form method="POST" action="/login" style="display: flex; flex-direction: column; gap: 14px;">
        <input type="password" name="password" placeholder="Password Akses..." required autofocus class="form-input-pro" style="padding: 12px 16px; font-size: 1rem; text-align: center;">
        <button type="submit" class="nav-btn" style="width: 100%; justify-content: center; padding: 12px; background: var(--accent-gradient); color: white; border: none; font-size: 0.95rem; font-weight: 700; border-radius: 12px;">Buka HaruDrive</button>
      </form>
    </div>
  </div>`;
}

function publicUI() {
  return `
    <!-- TOP FLOATING BAR (Subtle Admin & Theme Controls) -->
  <div class="guest-top-controls">
    <button class="btn-subtle-ctrl" id="darkToggle" title="Ganti Tema">
      <svg class="icon icon-xs" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
    </button>
  </div>

  <!-- GUEST CENTERED CARD (Clean Headerless Index - Screenshot 2 Style) -->
  <main class="guest-card-wrapper">
    <div class="guest-main-card glass">
      
      <!-- FOLDER HEADER -->
      <div class="guest-header-box">
        <div class="guest-folder-icon-large">
          <svg viewBox="0 0 24 24" fill="#f59e0b"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </div>
        <h1 class="guest-card-title" id="guestCardTitle">HaruDrive Storage</h1>
        <div class="guest-card-stats" id="guestCardStats">Memuat isi folder...</div>
      </div>

      <!-- BREADCRUMBS -->
      <div class="guest-breadcrumb-strip">
        <div class="crumb-group" id="breadcrumbNav">
          <a href="/" class="crumb" onclick="navigateTo('/'); return false;">
            <svg class="icon icon-xs" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
            <span>Home</span>
          </a>
        </div>
      </div>

      <!-- TABLE LIST -->
      <div class="guest-table-box">
        <div class="guest-table-header">
          <div class="col-cb"><input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll(this.checked)"></div>
          <div class="col-name">NAME</div>
          <div class="col-size" style="text-align: right;">SIZE</div>
          <div class="col-actions" style="text-align: center;">ACTIONS</div>
        </div>
        <div id="fileListContainer" class="guest-file-list">
          <div style="text-align: center; padding: 40px; color: var(--text-muted);">
            <div class="pulse-dot" style="margin: 0 auto 12px; width: 12px; height: 12px;"></div>
            <p>Menghubungkan ke HaruDrive Storage...</p>
          </div>
        </div>
      </div>

      <!-- BOTTOM ACTIONS (Green Button) -->
      <div class="guest-bottom-actions">
        <button class="btn-bulk-download-green" id="btnBulkDownload" onclick="bulkDownloadSelected()">
          <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span id="bulkDownloadText">Download Selected (0)</span>
        </button>
        <button class="btn-bulk-copy-subtle" id="btnBulkCopy" onclick="bulkCopyLinks()">
          <svg class="icon icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          <span>Copy</span>
        </button>
      </div>

    </div>
  </main>

  <!-- BOTTOM-RIGHT TOAST NOTIFICATION (Exact screenshot style) -->
  <div id="toastCopiedBadge" class="toast-copied-badge">
    <div class="toast-check-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <span id="toastCopiedText">31 links copied</span>
  </div>

  <!-- THEATER PLYR VIDEO MODAL -->
  <div id="videoModal" class="modal-backdrop" style="display: none;">
    <div class="modal-card video-card">
      <div class="modal-header">
        <span class="modal-title" id="videoModalTitle">Video Player</span>
        <button class="btn-close-circle" onclick="closeVideoModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="video-container-wrap">
        <video id="plyrPlayer" playsinline controls></video>
      </div>
      <div class="modal-body" style="padding: 12px 18px 14px;">
        <div style="font-size: 0.72rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; margin-bottom: 6px;">Buka di External Player:</div>
        <div class="external-players-row" id="externalPlayersContainer"></div>
      </div>
    </div>
  </div>
  `;
}

function publicIndexUI() {
  return `
  <!-- PUBLIC FILE MANAGER TOPBAR -->
  <header class="navbar-cyber glass">
    <div class="nav-container">
      <div class="nav-left">
        <a href="javascript:void(0)" class="brand-logo" onclick="navigateTo('', ''); return false;">
          <div class="logo-glow-wrap">
            <svg class="sakura-icon-svg" viewBox="0 0 24 24"><path d="M12 2a4 4 0 0 0-3.5 6 4 4 0 0 0-6 3.5 4 4 0 0 0 3.5 6 4 4 0 0 0 6 3.5 4 4 0 0 0 6-3.5 4 4 0 0 0 3.5-6 4 4 0 0 0-3.5-6 4 4 0 0 0-6-3.5z"/><circle cx="12" cy="12" r="2.5" fill="#ffffff"/></svg>
          </div>
          <div class="brand-info">
            <span class="brand-title">HaruDrive</span>
            <span class="brand-subtag" style="color: #6366f1;">Public Drive</span>
          </div>
        </a>
      </div>
      <div class="nav-right">
        <button class="nav-btn" id="storageModeToggle" onclick="toggleStorageMode()" title="Saat ini: GDrive — klik untuk ganti ke HF" style="border-color: rgba(99,102,241,0.3);">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M12 2v8M12 14v8"/><path d="M4.93 10a5 5 0 0 1 6.07-6"/><path d="M19.07 14a5 5 0 0 1-6.07 6"/><circle cx="12" cy="12" r="3"/></svg>
          <span id="storageModeLabel">Mode: GDrive</span>
        </button>
        <a href="/admin" class="nav-btn" title="Masuk ke Admin Console">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span class="btn-text-label">Admin</span>
        </a>
        <button class="nav-btn" id="darkToggle" title="Ganti Tema">
          <svg class="icon icon-sm" id="themeIcon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
        <a href="/logout" class="nav-btn" title="Keluar" style="color: #ef4444;">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          <span class="btn-text-label">Keluar</span>
        </a>
      </div>
    </div>
  </header>

  <div class="container">
    <div class="breadcrumb-bar glass">
      <div class="crumb-group" id="breadcrumbNav">
        <a href="javascript:void(0)" class="crumb" onclick="navigateTo('', ''); return false;">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>Home</span>
        </a>
      </div>
      <div class="toolbar-actions">
        <div class="search-box">
          <svg class="icon icon-xs" viewBox="0 0 24 24" style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-dim); pointer-events: none;"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="searchInput" class="form-input-pro" placeholder="Cari file global (Ctrl+K)" style="padding-left: 36px; padding-right: 36px;">
          <button id="searchClearBtn" class="search-clear-btn" title="Hapus pencarian" style="position:absolute; right:8px; top:50%; transform:translateY(-50%); display:none; background:rgba(255,255,255,0.08); border:1px solid var(--border); border-radius:50%; width:22px; height:22px; align-items:center; justify-content:center; cursor:pointer; color:var(--text-dim);"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <button class="btn-action-tool" onclick="loadFolder(currentPath, currentFolderId)" title="Refresh">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          <span>Refresh</span>
        </button>
      </div>
    </div>

    <div class="folder-stats-label" id="folderStatsLabel"></div>

    <!-- File Table -->
    <div class="file-table-wrapper glass">
      <div class="table-header" id="list-header">
        <div class="col-cb"><input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll(this.checked)"></div>
        <div class="col-name gdi-sort-header" data-sort="name" style="cursor:pointer;">Nama File / Folder</div>
        <div class="col-size gdi-sort-header" data-sort="size" style="cursor:pointer; text-align:right;">Ukuran</div>
        <div class="col-date gdi-sort-header" data-sort="date" style="cursor:pointer; text-align:right;">Diperbarui</div>
        <div class="col-actions">Aksi</div>
      </div>
      <div id="fileListContainer">
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <div class="pulse-dot" style="margin: 0 auto 12px; width: 12px; height: 12px;"></div>
          <p>Memuat daftar file...</p>
        </div>
      </div>
    </div>
  </div>

  <!-- FLOATING BULK TOOLBAR (PUBLIC) -->
  <div id="bulkToolbar" class="bulk-toolbar" style="display: none;">
    <span id="bulkCount" class="bulk-count-badge">0 Dipilih</span>
    <button class="btn-bulk" id="bulkDownloadBtn" style="color: #10b981;" onclick="bulkDownloadSelected()">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      <span>Download</span>
    </button>
    <button class="btn-bulk" style="color: var(--primary-light);" onclick="bulkCopyLinks()">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      <span>Salin</span>
    </button>
    <button class="btn-bulk-close" onclick="clearBulkSelection()" title="Batal Pilih">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>

  <!-- TOAST -->
  <div id="toastCopiedBadge" class="toast-copied-badge">
    <div class="toast-check-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
    </div>
    <span id="toastCopiedText">31 links copied</span>
  </div>

  <!-- VIDEO MODAL -->
  <div id="videoModal" class="modal-backdrop" style="display: none;">
    <div class="modal-card video-card">
      <div class="modal-header">
        <span class="modal-title" id="videoModalTitle">Video Player</span>
        <button class="btn-close-circle" onclick="closeVideoModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="video-container-wrap">
        <video id="plyrPlayer" playsinline controls></video>
      </div>
      <div class="modal-body" style="padding: 12px 18px 14px;">
        <div style="font-size: 0.72rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; margin-bottom: 6px;">Buka di External Player:</div>
        <div class="external-players-row" id="externalPlayersContainer"></div>
      </div>
    </div>
  </div>
  `;
}

function adminConsoleUI() {
  return `
  <!-- TOP NAVBAR -->
  <header class="navbar-cyber glass">
    <div class="nav-container">
      <div class="nav-left">
        <a href="javascript:void(0)" class="brand-logo" onclick="navigateToAdmin('')">
          <div class="logo-glow-wrap">
            <svg class="sakura-icon-svg" viewBox="0 0 24 24"><path d="M12 2a4 4 0 0 0-3.5 6 4 4 0 0 0-6 3.5 4 4 0 0 0 3.5 6 4 4 0 0 0 6 3.5 4 4 0 0 0 3.5-6 4 4 0 0 0-3.5-6 4 4 0 0 0-6-3.5z"/><circle cx="12" cy="12" r="2.5" fill="#ffffff"/></svg>
          </div>
          <div class="brand-info">
            <span class="brand-title">HaruDrive</span>
            <span class="brand-subtag" style="color: #10b981;">Admin Console</span>
          </div>
        </a>
      </div>

      <div class="nav-right">
        <button class="nav-btn" id="storageModeToggleAdmin" onclick="toggleStorageMode()" title="Saat ini: GDrive — klik untuk ganti ke HF" style="border-color: rgba(99,102,241,0.3);">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M12 2v8M12 14v8"/><path d="M4.93 10a5 5 0 0 1 6.07-6"/><path d="M19.07 14a5 5 0 0 1-6.07 6"/><circle cx="12" cy="12" r="3"/></svg>
          <span id="storageModeLabelAdmin">Mode: GDrive</span>
        </button>
        <a href="/" class="nav-btn" title="Kembali ke Web Publik">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span class="btn-text-label">Web Publik</span>
        </a>

        <button class="nav-btn" style="background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.35); color: #ef4444;" onclick="lockAdminSession()" title="Kunci Mode Admin">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span class="btn-text-label">Kunci Admin</span>
        </button>

        <a href="/logout" class="nav-btn" title="Keluar" style="color: #ef4444;">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          <span class="btn-text-label">Keluar</span>
        </a>

        <button class="nav-btn" id="darkToggle" title="Ganti Tema">
          <svg class="icon icon-sm" id="themeIcon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>
      </div>
    </div>
  </header>

  <!-- AUTH BARRIER -->
  <div id="adminLoginGate" style="display: none; min-height: 75vh; align-items: center; justify-content: center; padding: 20px;">
    <div class="glass" style="max-width: 440px; width: 100%; padding: 36px 32px; border-radius: 24px; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.4);">
      <div class="logo-glow-wrap" style="margin: 0 auto 16px; width: 56px; height: 56px;">
        <svg class="icon icon-lg" style="color: #ec4899;" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      </div>
      <h2 style="font-size: 1.4rem; font-weight: 800; margin-bottom: 6px;">Admin Storage Console</h2>
      <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 20px;">Masukkan PIN Admin untuk mengelola storage:</p>
      
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <input type="text" id="gatePinInput" inputmode="numeric" placeholder="••••••" maxlength="10" autocomplete="off" data-lpignore="true" data-1p-ignore="true" class="form-input-pro pin-input-stealth" onkeydown="if(event.key==='Enter')unlockAdminConsole()">
        <button class="nav-btn" style="width: 100%; justify-content: center; padding: 12px; background: var(--accent-gradient); color: white; border: none; font-size: 0.95rem; font-weight: 700;" onclick="unlockAdminConsole()">Buka Console Admin</button>
        <div id="loginPinError" style="display: none; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; padding: 9px 12px; border-radius: 10px; font-size: 0.82rem;"></div>
      </div>
    </div>
  </div>

  <!-- ADMIN CONSOLE CONTENT -->
  <div id="adminMainContent" class="container" style="display: none;">
    <div class="breadcrumb-bar glass">
      <div class="crumb-group" id="breadcrumbNav">
        <a href="javascript:void(0)" class="crumb" onclick="navigateToAdmin(''); return false;">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>Root</span>
        </a>
      </div>

      <div class="toolbar-actions">
        <div class="search-box">
          <svg class="icon icon-xs" viewBox="0 0 24 24" style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--text-dim); pointer-events: none;"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="searchInput" class="form-input-pro" placeholder="Cari file global (Ctrl+K)" style="padding-left: 36px; padding-right: 36px;">
          <button id="searchClearBtn" class="search-clear-btn" title="Hapus pencarian" style="position:absolute; right:8px; top:50%; transform:translateY(-50%); display:none; background:rgba(255,255,255,0.08); border:1px solid var(--border); border-radius:50%; width:22px; height:22px; align-items:center; justify-content:center; cursor:pointer; color:var(--text-dim);"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <button id="uploadBtn" class="btn-action-tool" style="background: rgba(99, 102, 241, 0.15); border-color: rgba(99, 102, 241, 0.4); color: var(--primary-light);" onclick="openUploadModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <span>Upload File</span>
        </button>

        <button id="newFolderBtn" class="btn-action-tool" style="background: rgba(16, 185, 129, 0.12); border-color: rgba(16, 185, 129, 0.35); color: #10b981;" onclick="openNewFolderModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg>
          <span>Folder Baru</span>
        </button>

        <button id="cloudMirrorBtn" class="btn-action-tool" style="background: rgba(236, 72, 153, 0.12); border-color: rgba(236, 72, 153, 0.35); color: #ec4899;" onclick="openMirrorModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><polyline points="12 13 12 7 9 10"/><polyline points="12 7 15 10"/></svg>
          <span>Cloud Mirror</span>
        </button>

        <button class="btn-action-tool" style="background: rgba(14, 165, 233, 0.12); border-color: rgba(14, 165, 233, 0.35); color: #0ea5e9; position: relative;" onclick="openTaskManagerModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/></svg>
          <span>Task Manager</span>
          <span id="taskPulseDot" style="display: none; width: 7px; height: 7px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px #10b981; position: absolute; top: 4px; right: 4px;"></span>
        </button>

        <button id="syncIndexBtn" class="btn-action-tool" style="background: rgba(234, 179, 8, 0.12); border-color: rgba(234, 179, 8, 0.35); color: #eab308;" onclick="syncFromHF()" title="Sinkronkan seluruh index HF ke D1">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          <span>Sync Index</span>
        </button>

        <button class="btn-action-tool" onclick="loadFolder(currentPath, currentFolderId)" title="Refresh">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          <span>Refresh</span>
        </button>
      </div>
    </div>

    <div class="folder-stats-label" id="folderStatsLabel"></div>
    <div id="bandwidthIndicator" class="glass" style="display:flex; align-items:center; gap:12px; padding:8px 14px; margin-bottom:12px; border-radius:10px; font-size:0.78rem; font-weight:600;">
      <span style="color:var(--text-muted)">Bandwidth:</span>
      <span id="bwHf" style="color:#818cf8">HF: -</span>
      <span style="color:var(--border)">|</span>
      <span id="bwGDrive" style="color:#34d399">GDrive: -</span>
      <span id="bwUpdated" style="color:var(--text-dim); font-size:0.7rem; margin-left:auto;"></span>
    </div>

    <!-- Table -->
    <div class="file-table-wrapper glass">
      <div class="table-header" id="list-header">
        <div class="col-cb"><input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll(this.checked)"></div>
        <div class="col-name gdi-sort-header" data-sort="name" style="cursor:pointer;">Nama File / Folder</div>
        <div class="col-size gdi-sort-header" data-sort="size" style="cursor:pointer; text-align:right;">Ukuran</div>
        <div class="col-date gdi-sort-header" data-sort="date" style="cursor:pointer; text-align:right;">Diperbarui</div>
        <div class="col-actions">Kelola</div>
      </div>
      <div id="fileListContainer">
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <div class="pulse-dot" style="margin: 0 auto 12px; width: 12px; height: 12px;"></div>
          <p>Menghubungkan ke HaruDrive Storage...</p>
        </div>
      </div>
    </div>
  </div>

  <!-- FLOATING BULK TOOLBAR (ADMIN) -->
  <div id="bulkToolbar" class="bulk-toolbar" style="display: none;">
    <span id="bulkCount" class="bulk-count-badge">0 Dipilih</span>
    <button class="btn-bulk" style="color: var(--primary-light);" onclick="openBulkMoveModal()">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/><path d="M3 12h12"/></svg>
      <span>Pindah</span>
    </button>
    <button class="btn-bulk danger" onclick="bulkDeleteSelected()">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      <span>Hapus</span>
    </button>
    <button class="btn-bulk" onclick="bulkCopyLinks()">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      <span>Salin</span>
    </button>
    <button class="btn-bulk-close" onclick="clearBulkSelection()" title="Batal Pilih">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  </div>

  <!-- UPLOAD MODAL -->
  <div id="uploadModal" class="modal-backdrop" style="display: none;">
    <div class="modal-card">
      <div class="modal-header">
        <span class="modal-title">Upload File ke Storage</span>
        <button class="btn-close-circle" onclick="closeUploadModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="dropzone-box" onclick="document.getElementById('manualFileInput').click()">
          <svg class="icon icon-lg" style="margin: 0 auto 8px; color: var(--accent);" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <p style="font-size: 0.9rem; font-weight: 700; color: var(--text);">Pilih File dari HP / Laptop</p>
          <p style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">Atau drag and drop file langsung ke sini</p>
          <input type="file" id="manualFileInput" style="display: none;" onchange="handleFileSelected(this.files)">
        </div>

        <div id="selectedFileInfo" style="display: none; background: var(--bg-surface); padding: 10px 14px; border-radius: 10px; border: 1px solid var(--border);">
          <span id="selectedFileName" style="font-size: 0.85rem; font-weight: 600;"></span>
        </div>

        <label style="font-size: 0.82rem; font-weight: 600;">Pilih Folder Tujuan:</label>
        <div id="uploadFolderPicker" class="folder-tree-box"></div>
        <input type="hidden" id="uploadTargetDirInput">
        
        <div id="uploadProgressBox" style="display: none;">
          <div style="font-size: 0.82rem; color: var(--primary-light); margin-bottom: 4px;" id="uploadStatusText">Mengupload ke Storage...</div>
          <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden;">
            <div id="uploadProgressBar" style="width: 30%; height: 100%; background: var(--accent-gradient); border-radius: 4px; transition: width 0.3s;"></div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="nav-btn" onclick="closeUploadModal()">Batal</button>
        <button class="nav-btn" id="startUploadBtn" style="background: var(--accent-gradient); color: white; border: none;" onclick="submitManualUpload()">Upload File</button>
      </div>
    </div>
  </div>

  <!-- RENAME MODAL -->
  <div id="renameModal" class="modal-backdrop" style="display: none;">
    <div class="modal-card">
      <div class="modal-header">
        <span class="modal-title">Ubah Nama</span>
        <button class="btn-close-circle" onclick="closeRenameModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <input type="hidden" id="renameOldPath">
        <label style="font-size: 0.85rem; font-weight: 600;">Nama Baru:</label>
        <input type="text" id="renameNewNameInput" class="form-input-pro" placeholder="Nama file/folder baru...">
      </div>
      <div class="modal-footer">
        <button class="nav-btn" onclick="closeRenameModal()">Batal</button>
        <button class="nav-btn" style="background: var(--primary); color: white; border: none;" onclick="submitRename()">Simpan Nama</button>
      </div>
    </div>
  </div>

  <!-- MOVE MODAL -->
  <div id="moveModal" class="modal-backdrop" style="display: none;">
    <div class="modal-card">
      <div class="modal-header">
        <span class="modal-title">Pindahkan File</span>
        <button class="btn-close-circle" onclick="closeMoveModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <p id="moveTargetDesc" style="font-size: 0.85rem; color: var(--text-muted);"></p>
        <label style="font-size: 0.85rem; font-weight: 600;">Pilih Folder Tujuan:</label>
        <div id="moveFolderPicker" class="folder-tree-box"></div>
        <input type="hidden" id="moveDestinationInput">
      </div>
      <div class="modal-footer">
        <button class="nav-btn" onclick="closeMoveModal()">Batal</button>
        <button class="nav-btn" style="background: var(--accent-gradient); color: white; border: none;" onclick="submitMove()">Pindahkan Sekarang</button>
      </div>
    </div>
  </div>

  <!-- NEW FOLDER MODAL -->
  <div id="newFolderModal" class="modal-backdrop" style="display: none;">
    <div class="modal-card">
      <div class="modal-header">
        <span class="modal-title">Buat Folder Baru</span>
        <button class="btn-close-circle" onclick="closeNewFolderModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <label style="font-size: 0.85rem; font-weight: 600;">Nama Folder:</label>
        <input type="text" id="newFolderNameInput" class="form-input-pro" placeholder="Nama folder...">
      </div>
      <div class="modal-footer">
        <button class="nav-btn" onclick="closeNewFolderModal()">Batal</button>
        <button class="nav-btn" style="background: var(--primary); color: white; border: none;" onclick="submitNewFolder()">Buat Folder</button>
      </div>
    </div>
  </div>

  <!-- TASK MANAGER MODAL -->
  <div id="taskManagerModal" class="modal-backdrop" style="display: none;">
    <div class="modal-card" style="max-width: 580px;">
      <div class="modal-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <svg class="icon icon-sm" style="color: #0ea5e9;" viewBox="0 0 24 24"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/></svg>
          <span class="modal-title">Cloud Task Manager</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <button class="nav-btn" style="padding: 4px 8px; font-size: 0.72rem;" onclick="fetchAndRenderTasks()" title="Refresh Task">
            <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            <span>Perbarui</span>
          </button>
          <button class="btn-close-circle" onclick="closeTaskManagerModal()">
            <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
      <div class="modal-body" style="padding: 14px 18px; max-height: 60vh; overflow-y: auto;" id="taskManagerList">
        <div style="text-align: center; padding: 25px; color: var(--text-muted);">
          <div class="pulse-dot" style="margin: 0 auto 10px; width: 10px; height: 10px;"></div>
          <p style="font-size: 0.85rem;">Memuat daftar proses Cloud Mirror...</p>
        </div>
      </div>
      <div class="modal-footer" style="justify-content: space-between; align-items: center;">
        <span style="font-size: 0.74rem; color: var(--text-dim);">Auto-refresh aktif setiap 5 detik</span>
        <button class="nav-btn" onclick="closeTaskManagerModal()">Tutup</button>
      </div>
    </div>
  </div>

  <!-- CLOUD MIRROR MODAL -->
  <div id="mirrorModal" class="modal-backdrop" style="display: none;">
    <div class="modal-card">
      <div class="modal-header">
        <span class="modal-title">Cloud Mirror Runner</span>
        <button class="btn-close-circle" onclick="closeMirrorModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <label style="font-size: 0.84rem; font-weight: 600;">Google Drive URL / Folder Link:</label>
        <input type="text" id="mirrorGdriveUrl" class="form-input-pro" placeholder="https://drive.google.com/drive/folders/...">
        
        <label style="font-size: 0.84rem; font-weight: 600;">Pilih Folder Tujuan di HaruDrive:</label>
        <div id="mirrorFolderPicker" class="folder-tree-box"></div>
        <input type="hidden" id="mirrorTargetPath">
      </div>
      <div class="modal-footer">
        <button class="nav-btn" onclick="closeMirrorModal()">Batal</button>
        <button class="nav-btn" id="startMirrorBtn" style="background: var(--accent-gradient); color: white; border: none;" onclick="submitCloudMirror()">Mulai Mirror</button>
      </div>
    </div>
  </div>
  `;
}
