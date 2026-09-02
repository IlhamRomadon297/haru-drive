export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const HF_REPO_ID = env.HF_REPO_ID || 'harumidesu/harudrive-data';
    const HF_TOKEN = env.HF_TOKEN || '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';
    const APP_PASSWORD = env.APP_PASSWORD || 'HaruDrive_Desu';
    const ADMIN_PIN = env.ADMIN_PIN || '290722';
    const GITHUB_PAT = env.GITHUB_PAT || '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';
    const GITHUB_REPO = env.GITHUB_REPO || 'IlhamRomadon297/haru-drive';

    const cookie = request.headers.get('Cookie') || '';
    const isLoggedIn = cookie.includes('harudrive_auth=true');

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
        return new Response(htmlPage(loginUI('Password salah. Silakan coba lagi.'), env, 'login'), {
          headers: { 'Content-Type': 'text/html;charset=UTF-8' }
        });
      }
    }

    const isPublicRoute = url.pathname.startsWith('/file/') ||
                          url.pathname.startsWith('/d/') ||
                          url.pathname.startsWith('/raw/') ||
                          url.pathname.startsWith('/folder/') ||
                          (url.pathname === '/api/list' && (url.searchParams.has('path') || url.searchParams.has('id')));

    if (!isLoggedIn && !isPublicRoute) {
      if (url.pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(htmlPage(loginUI(), env, 'login'), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    if (url.pathname === '/logout') {
      return new Response('Logged out', {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': 'harudrive_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'
        }
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

        return new Response(JSON.stringify({ folderName, currentPath: reqPath, folderId: currentFolderId, files: formattedFiles }), {
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

