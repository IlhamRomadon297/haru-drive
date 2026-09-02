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

    return new Response(htmlPage(publicUI(), env, 'public'), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
};

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
    }
    .logo-glow-wrap {
      width: 38px;
      height: 38px;
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
    }
    .crumb-group {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.88rem;
      font-weight: 600;
      flex-wrap: wrap;
    }
    .crumb {
      color: var(--primary-light);
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
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
    .col-date { width: 130px; text-align: right; flex-shrink: 0; }
    .col-actions { width: 130px; text-align: right; flex-shrink: 0; }

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
    .file-date-cell { width: 130px; text-align: right; }

    .file-actions-cell {
      width: 130px;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
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
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        width: 100%;
      }
      .btn-action-tool {
        padding: 8px 10px;
        font-size: 0.78rem;
        width: 100%;
      }

      .col-date, .file-date-cell { display: none; }
      .col-size, .file-size-cell { display: none; }
      
      .table-header { padding: 10px 12px; }
      .file-row { padding: 10px 12px; }
      .col-cb { width: 28px; }
      
      .col-actions { width: 75px; }
      .file-actions-cell { width: 75px; gap: 4px; }
      body[data-mode="admin"] .col-actions { width: 105px; }
      body[data-mode="admin"] .file-actions-cell { width: 105px; gap: 3px; }

      .btn-act { width: 28px; height: 28px; }
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
  </style>
</head>
<body data-mode="${pageMode}">
  ${content}
  <script>
let currentPath = '';
let currentFolderId = '';
let allFiles = [];
let availableFolders = [''];
let activeFilter = 'all';
let selectedFiles = new Set();
let plyrPlayerInstance = null;
const isPageAdmin = document.body.getAttribute('data-mode') === 'admin';
let selectedUploadFile = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  if (localStorage.getItem('haruTheme') === 'light') {
    document.body.classList.add('light');
    updateThemeIcon(true);
  }

  if (isPageAdmin) {
    initAdminConsole();
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

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchInput?.focus();
    }
  });

  window.addEventListener('popstate', handlePopState);

  const isUnlocked = (localStorage.getItem('harudrive_admin_pin') || getCookie('harudrive_admin_pin')) === '290722';
  if (!isPageAdmin || isUnlocked) {
    const pathName = window.location.pathname;
    if (pathName.startsWith('/folder/')) {
      const fId = pathName.replace('/folder/', '').split('/')[0];
      loadFolder('', fId);
    } else {
      const urlParams = new URLSearchParams(window.location.search);
      const p = urlParams.get('p') || '';
      loadFolder(p, '');
    }
  }

  if (isPageAdmin) {
    fetchFolderTree(); fetchAndRenderTasks();
  }
});

// Admin Session
function initAdminConsole() {
  const gate = document.getElementById('adminLoginGate');
  const main = document.getElementById('adminMainContent');
  const savedPin = localStorage.getItem('harudrive_admin_pin') || getCookie('harudrive_admin_pin');

  if (savedPin === '290722') {
    if (gate) gate.style.display = 'none';
    if (main) main.style.display = 'block';
  } else {
    if (gate) gate.style.display = 'flex';
    if (main) main.style.display = 'none';
    setTimeout(() => document.getElementById('gatePinInput')?.focus(), 150);
  }
}

function unlockAdminConsole() {
  const pinInput = document.getElementById('gatePinInput');
  const pin = (pinInput?.value || '').trim();

  if (pin === '290722') {
    localStorage.setItem('harudrive_admin_pin', pin);
    setCookie('harudrive_admin_pin', pin, 30);
    
    document.getElementById('adminLoginGate').style.display = 'none';
    document.getElementById('adminMainContent').style.display = 'block';
    loadFolder(currentPath, currentFolderId);
    fetchFolderTree(); fetchAndRenderTasks();
  } else {
    alert('PIN Admin Salah!');
    pinInput?.focus();
    pinInput?.select();
  }
}

function lockAdminSession() {
  localStorage.removeItem('harudrive_admin_pin');
  deleteCookie('harudrive_admin_pin');
  document.getElementById('adminLoginGate').style.display = 'flex';
  document.getElementById('adminMainContent').style.display = 'none';
  alert('Console Admin telah dikunci.');
}

// Navigation
function navigateTo(path, id = '', pushHistory = true) {
  if (pushHistory) {
    const targetUrl = id ? \`/folder/\${id}\` : (path ? \`/?p=\${encodeURIComponent(path)}\` : '/');
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
  
  const folders = Array.from(new Set(['', ...availableFolders]));

  folders.forEach(f => {
    const isSelected = f === selectedValue;
    const displayName = f ? \`/\${f}\` : 'Root (/)';
    const indent = f ? (f.split('/').length - 1) * 14 : 0;

    html += \`
      <div class="folder-tree-item \${isSelected ? 'selected' : ''}" style="margin-left: \${indent}px;" onclick="selectFolderPickerItem('\${containerId}', '\${inputId}', '\${escapeJs(f)}')">
        <svg class="icon icon-sm" style="color: #f59e0b;" viewBox="0 0 24 24"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>
        <span>\${escapeHtml(displayName)}</span>
        \${isSelected ? '<span style="margin-left: auto; font-size: 0.8rem; color: #ec4899;">✓</span>' : ''}
      </div>
    \`;
  });

  container.innerHTML = html;
}

function selectFolderPickerItem(containerId, inputId, folderPath) {
  renderFolderPickerUI(containerId, inputId, folderPath);
}

// Load Folder Files
async function loadFolder(path = '', id = '') {
  currentPath = path;
  currentFolderId = id;
  selectedFiles.clear();
  updateBulkToolbar();

  const container = document.getElementById('fileListContainer');
  if (container) {
    container.innerHTML = \`
      <div style="text-align: center; padding: 40px; color: var(--text-muted);">
        <div class="pulse-dot" style="margin: 0 auto 12px; width: 12px; height: 12px;"></div>
        <p>Memuat daftar file...</p>
      </div>\`;
  }

  try {
    let fetchUrl = \`/api/list\`;
    if (id) {
      fetchUrl += \`?id=\${encodeURIComponent(id)}\`;
    } else if (path) {
      fetchUrl += \`?path=\${encodeURIComponent(path)}\`;
    }

    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(\`HTTP Error \${res.status}\`);
    const data = await res.json();

    currentPath = data.currentPath || '';
    currentFolderId = data.folderId || '';
    allFiles = data.files || [];

    updateBreadcrumbs();
    renderFileList();
  } catch (err) {
    if (container) {
      container.innerHTML = \`
        <div style="text-align: center; padding: 40px; color: #ef4444;">
          <p>Gagal memuat: \${err.message}</p>
          <button class="nav-btn" style="margin-top: 12px;" onclick="loadFolder(currentPath, currentFolderId)">Coba Lagi</button>
        </div>\`;
    }
  }
}

// Render File Table
function renderFileList() {
  const container = document.getElementById('fileListContainer');
  if (!container) return;

  const filtered = allFiles.filter(item => {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'folder') return item.mimeType === 'application/vnd.google-apps.folder';
    if (activeFilter === 'video') return item.mimeType.startsWith('video/');
    if (activeFilter === 'archive') return item.mimeType.includes('zip') || item.mimeType.includes('rar') || item.mimeType.includes('tar') || item.mimeType.includes('7z');
    if (activeFilter === 'document') return item.mimeType.includes('pdf') || item.mimeType.includes('text');
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = \`
      <div style="text-align: center; padding: 40px; color: var(--text-muted);">
        <p>Tidak ada file di direktori ini.</p>
      </div>\`;
    return;
  }

  let html = '';
  filtered.forEach(file => {
    const isDir = file.mimeType === 'application/vnd.google-apps.folder';
    const isVideo = file.mimeType.startsWith('video/');
    const iconType = isDir ? 'folder' : (isVideo ? 'video' : (file.mimeType.includes('zip') ? 'archive' : 'file'));
    const isChecked = selectedFiles.has(file.path);

    const downloadShortLink = \`/d/\${file.id}\`;

    const clickAction = isDir 
      ? (isPageAdmin ? \`navigateToAdmin('\${escapeJs(file.path)}')\` : \`navigateTo('\${escapeJs(file.path)}', '\${file.id}')\`)
      : (isVideo ? \`playVideo('\${file.id}', '\${escapeJs(file.name)}')\` : \`downloadFile('\${file.id}')\`);

    html += \`
    <div class="file-row \${isDir ? 'is-folder' : ''}">
      <div class="col-cb">
        <input type="checkbox" \${isChecked ? 'checked' : ''} onchange="toggleItemSelect('\${escapeJs(file.path)}', this.checked)">
      </div>
      <div class="file-name-cell" onclick="\${clickAction}" title="\${isDir ? 'Buka Folder' : (isVideo ? 'Klik untuk Putar Video' : 'Download File')}">
        <div class="file-icon-box \${iconType}">
          \${getModernSvgIcon(iconType)}
        </div>
        <span class="file-title" title="\${escapeHtml(file.name)}">\${escapeHtml(file.name)}</span>
      </div>
      <div class="file-size-cell">\${isDir ? '-' : formatBytes(file.size)}</div>
      <div class="file-date-cell">\${formatDate(file.modifiedTime)}</div>
      <div class="file-actions-cell">
        \${!isPageAdmin ? \`
          \${!isDir ? \`
            <a class="btn-act" href="\${downloadShortLink}" title="Download">
              <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </a>
            <button class="btn-act" onclick="copyShortLink('\${file.id}')" title="Salin Shortlink">
              <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            </button>
          \` : ''}
        \` : \`
          <button class="btn-act" onclick="openRenameModal('\${escapeJs(file.path)}', '\${escapeJs(file.name)}')" title="Ubah Nama">
            <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          </button>
          <button class="btn-act" onclick="openMoveModalSingle('\${escapeJs(file.path)}')" title="Pindahkan">
            <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/><path d="M3 12h12"/></svg>
          </button>
          <button class="btn-act btn-delete" onclick="deleteSingleItem('\${escapeJs(file.path)}')" title="Hapus Permanen">
            <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        \`}
      </div>
    </div>\`;
  });

  container.innerHTML = html;
}

// Breadcrumbs
function updateBreadcrumbs() {
  const nav = document.getElementById('breadcrumbNav');
  if (!nav) return;

  let html = \`
    <a href="javascript:void(0)" class="crumb" onclick="\${isPageAdmin ? \`navigateToAdmin('')\` : \`navigateTo('')\`}; return false;">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      <span>Home</span>
    </a>\`;

  if (currentPath) {
    const parts = currentPath.split('/');
    let accum = '';
    parts.forEach((p, idx) => {
      accum = accum ? \`\${accum}/\${p}\` : p;
      const isLast = idx === parts.length - 1;
      html += \`<span class="crumb-sep">/</span>\`;
      if (isLast) {
        html += \`<span class="crumb-current">\${escapeHtml(p)}</span>\`;
      } else {
        html += \`<a href="javascript:void(0)" class="crumb" onclick="\${isPageAdmin ? \`navigateToAdmin('\${escapeJs(accum)}')\` : \`navigateTo('\${escapeJs(accum)}')\`}; return false;">\${escapeHtml(p)}</a>\`;
      }
    });
  }

  nav.innerHTML = html;
}

// PLYR Video Player Modal
function playVideo(shortId, filename) {
  const modal = document.getElementById('videoModal');
  const videoEl = document.getElementById('plyrPlayer');
  const titleEl = document.getElementById('videoModalTitle');
  const extEl = document.getElementById('externalPlayersContainer');
  if (!modal || !videoEl) return;

  const streamUrl = \`\${window.location.origin}/file/\${shortId}\`;
  titleEl.textContent = filename;

  extEl.innerHTML = \`
    <a href="vlc://\${streamUrl}" class="btn-ext-player" title="Buka di VLC">VLC</a>
    <a href="potplayer://\${streamUrl}" class="btn-ext-player" title="Buka di PotPlayer">PotPlayer</a>
    <a href="iina://weblink?url=\${encodeURIComponent(streamUrl)}" class="btn-ext-player" title="Buka di IINA">IINA</a>
    <a href="intent:\${streamUrl}#Intent;package=com.mxtech.videoplayer.ad;type=video/*;end" class="btn-ext-player" title="Buka di MX Player">MX Player</a>
    <a href="/d/\${shortId}" class="btn-ext-player" style="margin-left: auto; background: var(--primary); color: white; border: none;">Download File</a>
  \`;

  if (plyrPlayerInstance) {
    try { plyrPlayerInstance.destroy(); } catch (e) {}
  }

  videoEl.src = streamUrl;
  modal.style.display = 'flex';
  document.body.classList.add('modal-open');

  if (window.Plyr) {
    plyrPlayerInstance = new Plyr(videoEl, {
      autoplay: false,
      keyboard: { global: true, focused: true },
      tooltips: { controls: true, seek: true }
    });
  }
}

function closeVideoModal() {
  const modal = document.getElementById('videoModal');
  const videoEl = document.getElementById('plyrPlayer');
  if (modal) modal.style.display = 'none';
  document.body.classList.remove('modal-open');

  if (plyrPlayerInstance) {
    try { plyrPlayerInstance.destroy(); } catch (e) {}
    plyrPlayerInstance = null;
  }
  if (videoEl) {
    videoEl.pause();
    videoEl.src = '';
  }
}

function copyShortLink(shortId) {
  const link = \`\${window.location.origin}/file/\${shortId}\`;
  navigator.clipboard.writeText(link).then(() => {
    alert(\`Shortlink berhasil disalin!\\n\${link}\`);
  }).catch(() => {
    prompt('Salin link ini:', link);
  });
}

function downloadFile(shortId) {
  window.location.href = \`/d/\${shortId}\`;
}

// Manual Upload Modal (Admin)
async function openUploadModal() {
  const m = document.getElementById('uploadModal');
  if (!m) return;

  await fetchFolderTree(); fetchAndRenderTasks();
  renderFolderPickerUI('uploadFolderPicker', 'uploadTargetDirInput', currentPath);
  selectedUploadFile = null;
  document.getElementById('selectedFileInfo').style.display = 'none';
  document.getElementById('uploadProgressBox').style.display = 'none';
  m.style.display = 'flex';
}
function closeUploadModal() {
  const m = document.getElementById('uploadModal');
  if (m) m.style.display = 'none';
}
function handleFileSelected(files) {
  if (files && files.length > 0) {
    selectedUploadFile = files[0];
    document.getElementById('selectedFileName').textContent = \`\${selectedUploadFile.name} (\${formatBytes(selectedUploadFile.size)})\`;
    document.getElementById('selectedFileInfo').style.display = 'block';
  }
}
async function submitManualUpload() {
  if (!selectedUploadFile) return alert('Silakan pilih file terlebih dahulu!');
  const targetDir = (document.getElementById('uploadTargetDirInput').value || '').trim();
  const pin = localStorage.getItem('harudrive_admin_pin') || getCookie('harudrive_admin_pin') || '290722';

  const progressBox = document.getElementById('uploadProgressBox');
  const progressBar = document.getElementById('uploadProgressBar');
  const statusText = document.getElementById('uploadStatusText');
  const btn = document.getElementById('startUploadBtn');

  progressBox.style.display = 'block';
  progressBar.style.width = '45%';
  statusText.textContent = \`Mengupload \${selectedUploadFile.name}...\`;
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
      fetchFolderTree(); fetchAndRenderTasks();
      alert(\`File berhasil diunggah ke /\${data.path}\`);
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

// Rename Modal
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
  const newPath = pathParts.length ? \`\${pathParts.join('/')}/\${newName}\` : newName;
  const pin = localStorage.getItem('harudrive_admin_pin') || getCookie('harudrive_admin_pin') || '290722';

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
      fetchFolderTree(); fetchAndRenderTasks();
    } else {
      alert('Gagal rename: ' + (data.error || 'Terjadi kesalahan'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// Move Modal
let moveItemsQueue = [];
function openMoveModalSingle(itemPath) {
  moveItemsQueue = [itemPath];
  const m = document.getElementById('moveModal');
  const desc = document.getElementById('moveTargetDesc');
  if (!m) return;

  desc.textContent = \`Memindahkan: \${itemPath.split('/').pop()}\`;
  renderFolderPickerUI('moveFolderPicker', 'moveDestinationInput', currentPath);
  m.style.display = 'flex';
}
function openBulkMoveModal() {
  moveItemsQueue = Array.from(selectedFiles);
  if (!moveItemsQueue.length) return;

  const m = document.getElementById('moveModal');
  const desc = document.getElementById('moveTargetDesc');
  if (!m) return;

  desc.textContent = \`Memindahkan \${moveItemsQueue.length} item terpilih.\`;
  renderFolderPickerUI('moveFolderPicker', 'moveDestinationInput', currentPath);
  m.style.display = 'flex';
}
function closeMoveModal() {
  const m = document.getElementById('moveModal');
  if (m) m.style.display = 'none';
  moveItemsQueue = [];
}
async function submitMove() {
  const destFolder = (document.getElementById('moveDestinationInput').value || '').trim();
  const pin = localStorage.getItem('harudrive_admin_pin') || getCookie('harudrive_admin_pin') || '290722';

  try {
    const res = await fetch('/api/admin/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: moveItemsQueue, target_folder: destFolder, admin_pin: pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      closeMoveModal();
      clearBulkSelection();
      loadFolder(currentPath, currentFolderId);
      fetchFolderTree(); fetchAndRenderTasks();
      alert(\`Berhasil memindahkan \${data.movedCount} item ke /\${destFolder}\`);
    } else {
      alert('Gagal memindahkan: ' + (data.error || 'Terjadi kesalahan'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// New Folder Modal
function openNewFolderModal() {
  const m = document.getElementById('newFolderModal');
  if (m) {
    m.style.display = 'flex';
    document.getElementById('newFolderNameInput')?.focus();
  }
}
function closeNewFolderModal() {
  const m = document.getElementById('newFolderModal');
  if (m) m.style.display = 'none';
}
async function submitNewFolder() {
  const nameInput = document.getElementById('newFolderNameInput');
  const folderName = (nameInput?.value || '').trim();
  if (!folderName) return alert('Masukkan nama folder!');

  const pin = localStorage.getItem('harudrive_admin_pin') || getCookie('harudrive_admin_pin') || '290722';
  const targetPath = currentPath ? \`\${currentPath}/\${folderName}\` : folderName;

  try {
    const res = await fetch('/api/admin/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_path: targetPath, admin_pin: pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      closeNewFolderModal();
      if (nameInput) nameInput.value = '';
      loadFolder(currentPath, currentFolderId);
      fetchFolderTree(); fetchAndRenderTasks();
    } else {
      alert('Gagal: ' + (data.error || 'Terjadi kesalahan'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// Single Delete
async function deleteSingleItem(itemPath) {
  if (!confirm(\`Yakin ingin menghapus permanent:\\n\${itemPath}?\`)) return;
  const pin = localStorage.getItem('harudrive_admin_pin') || getCookie('harudrive_admin_pin') || '290722';

  try {
    const res = await fetch('/api/admin/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: itemPath, admin_pin: pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      loadFolder(currentPath, currentFolderId);
      fetchFolderTree(); fetchAndRenderTasks();
    } else {
      alert('Gagal menghapus: ' + (data.error || 'Error'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// Bulk Selection
function toggleItemSelect(itemPath, checked) {
  if (checked) selectedFiles.add(itemPath);
  else selectedFiles.delete(itemPath);
  updateBulkToolbar();
}

function toggleSelectAll(checked) {
  allFiles.forEach(f => {
    if (checked) selectedFiles.add(f.path);
    else selectedFiles.delete(f.path);
  });
  renderFileList();
  updateBulkToolbar();
}

function updateBulkToolbar() {
  const bar = document.getElementById('bulkToolbar');
  const countEl = document.getElementById('bulkCount');
  if (!bar) return;

  if (selectedFiles.size > 0) {
    bar.style.display = 'flex';
    if (countEl) countEl.textContent = \`\${selectedFiles.size} Item\`;
  } else {
    bar.style.display = 'none';
  }
}

function clearBulkSelection() {
  selectedFiles.clear();
  renderFileList();
  updateBulkToolbar();
}

async function bulkDeleteSelected() {
  if (!confirm(\`Hapus permanent \${selectedFiles.size} item yang dipilih?\`)) return;
  const pin = localStorage.getItem('harudrive_admin_pin') || getCookie('harudrive_admin_pin') || '290722';

  try {
    const res = await fetch('/api/admin/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: Array.from(selectedFiles), admin_pin: pin })
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

function bulkCopyLinks() {
  const links = Array.from(selectedFiles).map(p => {
    const file = allFiles.find(f => f.path === p);
    return file ? \`\${window.location.origin}/file/\${file.id}\` : '';
  }).filter(Boolean).join('\\n');

  navigator.clipboard.writeText(links).then(() => {
    alert(\`Berhasil menyalin \${selectedFiles.size} shortlink!\`);
  });
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

  const pin = localStorage.getItem('harudrive_admin_pin') || getCookie('harudrive_admin_pin') || prompt('Masukkan PIN Admin:');
  if (!pin) return;

  const btn = document.getElementById('startMirrorBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Memulai Runner Cloud...'; }

  try {
    const res = await fetch('/api/admin/mirror', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gdrive_url: gdriveUrl, target_path: targetPath, admin_pin: pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      closeMirrorModal();
      openTaskManagerModal();
    } else {
      alert('Gagal: ' + (data.error || 'Akses Ditolak'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Mulai Mirror'; }
  }
}

// Theme
function toggleTheme() {
  const isLight = document.body.classList.toggle('light');
  localStorage.setItem('haruTheme', isLight ? 'light' : 'dark');
  updateThemeIcon(isLight);
}
function updateThemeIcon(isLight) {
  const icon = document.getElementById('themeIcon');
  if (icon) {
    icon.innerHTML = isLight 
      ? '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  }
}

// Modern SVG Icons
function getModernSvgIcon(type) {
  if (type === 'folder') {
    return \`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>\`;
  }
  if (type === 'video') {
    return \`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ec4899" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 3 20 12 6 21 6 3"/></svg>\`;
  }
  if (type === 'archive') {
    return \`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="20" x="2" y="2" rx="5" ry="5"/><path d="M10 2v20"/><path d="M14 2v20"/><path d="M2 12h20"/></svg>\`;
  }
  return \`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><polyline points="14 2 14 8 20 8"/></svg>\`;
}


let taskPollInterval = null;

async function openTaskManagerModal() {
  const m = document.getElementById('taskManagerModal');
  if (!m) return;
  m.style.display = 'flex';
  await fetchAndRenderTasks();
  if (!taskPollInterval) {
    taskPollInterval = setInterval(fetchAndRenderTasks, 5000);
  }
}

function closeTaskManagerModal() {
  const m = document.getElementById('taskManagerModal');
  if (m) m.style.display = 'none';
  if (taskPollInterval) {
    clearInterval(taskPollInterval);
    taskPollInterval = null;
  }
}

async function fetchAndRenderTasks() {
  const listEl = document.getElementById('taskManagerList');
  const dotEl = document.getElementById('taskPulseDot');

  try {
    const res = await fetch('/api/admin/mirror-tasks');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const runs = data.runs || [];

    if (dotEl) {
      dotEl.style.display = data.hasActive ? 'block' : 'none';
    }

    if (!listEl) return;

    if (runs.length === 0) {
      listEl.innerHTML = '<div style="text-align: center; padding: 30px; color: var(--text-muted);"><p style="font-size: 0.85rem;">Belum ada task Cloud Mirror yang dijalankan.</p></div>';
      return;
    }

    let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';

    runs.forEach(run => {
      const isRunning = run.status === 'in_progress' || run.status === 'queued';
      const isSuccess = run.conclusion === 'success';
      const isFailed = run.conclusion === 'failure' || run.conclusion === 'cancelled' || run.conclusion === 'timed_out';

      let statusBadge = '';
      if (isRunning) {
        statusBadge = '<span style="display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 12px; font-size: 0.72rem; font-weight: 700; background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.35); color: #f59e0b;"><span class="pulse-dot" style="width: 6px; height: 6px; background: #f59e0b; box-shadow: 0 0 6px #f59e0b;"></span>' + (run.status === 'queued' ? 'Antre...' : 'Sedang Berjalan...') + '</span>';
      } else if (isSuccess) {
        statusBadge = '<span style="display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 12px; font-size: 0.72rem; font-weight: 700; background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.35); color: #10b981;">✓ Selesai</span>';
      } else {
        statusBadge = '<span style="display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 12px; font-size: 0.72rem; font-weight: 700; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #ef4444;">✕ ' + (run.conclusion || 'Gagal') + '</span>';
      }

      const timeAgo = formatTimeAgo(run.created_at);

      html += '<div style="background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 8px; transition: all 0.2s;">' +
        '<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">' +
          '<div style="display: flex; align-items: center; gap: 6px; min-width: 0;">' +
            '<svg class="icon icon-sm" style="color: var(--primary-light);" viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><polyline points="12 13 12 7 9 10"/><polyline points="12 7 15 10"/></svg>' +
            '<span style="font-size: 0.85rem; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">' + escapeHtml(run.display_title || 'Mirror Job #' + run.id) + '</span>' +
          '</div>' +
          statusBadge +
        '</div>' +
        '<div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.75rem; color: var(--text-dim);">' +
          '<span>Mulai: ' + timeAgo + '</span>' +
          '<div style="display: flex; align-items: center; gap: 6px;">' +
            (isRunning ? '<button class="nav-btn" style="padding: 3px 8px; font-size: 0.72rem; color: #ef4444; border-color: rgba(239,68,68,0.3); background: rgba(239,68,68,0.1);" onclick="cancelMirrorTask(' + run.id + ')">Batalkan</button>' : '') +
            '<a href="' + run.html_url + '" target="_blank" rel="noopener noreferrer" class="nav-btn" style="padding: 3px 8px; font-size: 0.72rem;">Logs ↗</a>' +
          '</div>' +
        '</div>' +
      '</div>';
    });

    html += '</div>';
    listEl.innerHTML = html;
  } catch (err) {
    if (listEl) {
      listEl.innerHTML = '<div style="text-align: center; padding: 20px; color: #ef4444; font-size: 0.85rem;">Gagal memuat task: ' + err.message + '</div>';
    }
  }
}

async function cancelMirrorTask(runId) {
  if (!confirm('Yakin ingin membatalkan task #' + runId + '?')) return;
  const pin = localStorage.getItem('harudrive_admin_pin') || getCookie('harudrive_admin_pin') || '290722';

  try {
    const res = await fetch('/api/admin/cancel-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_id: runId, admin_pin: pin })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      alert('Task berhasil dibatalkan!');
      fetchAndRenderTasks();
    } else {
      alert('Gagal membatalkan task: ' + (data.error || 'Akses ditolak'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return '-';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return Math.floor(diff) + ' dtk lalu';
  if (diff < 3600) return Math.floor(diff / 60) + ' mnt lalu';
  if (diff < 86400) return Math.floor(diff / 3600) + ' jam lalu';
  return Math.floor(diff / 86400) + ' hari lalu';
}

// Helpers
function setCookie(name, value, days) {
  let expires = "";
  if (days) {
    const date = new Date();
    date.setTime(date.getTime() + (days*24*60*60*1000));
    expires = "; expires=" + date.toUTCString();
  }
  document.cookie = name + "=" + (value || "")  + expires + "; path=/; SameSite=Lax";
}
function getCookie(name) {
  const nameEQ = name + "=";
  const ca = document.cookie.split(';');
  for(let i=0;i < ca.length;i++) {
    let c = ca[i];
    while (c.charAt(0)==' ') c = c.substring(1,c.length);
    if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length,c.length);
  }
  return null;
}
function deleteCookie(name) {
  document.cookie = name +'=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
function formatDate(dStr) {
  if (!dStr) return '-';
  const d = new Date(dStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function escapeHtml(str) {
  return (str || '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function escapeJs(str) {
  return (str || '').replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
}
function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}
async function handleSearch(e) {
  const q = (e.target.value || '').trim();
  if (!q) {
    loadFolder(currentPath, currentFolderId);
    return;
  }
  try {
    const res = await fetch(\`/api/search?q=\${encodeURIComponent(q)}\`);
    if (!res.ok) return;
    const data = await res.json();
    allFiles = data.files || [];
    renderFileList();
  } catch (err) {}
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
  <!-- TOP NAVBAR -->
  <header class="navbar-cyber glass">
    <div class="nav-container">
      <div class="nav-left">
        <a href="/" class="brand-logo" id="logoLink" onclick="navigateTo(''); return false;">
          <div class="logo-glow-wrap">
            <svg class="sakura-icon-svg" viewBox="0 0 24 24"><path d="M12 2a4 4 0 0 0-3.5 6 4 4 0 0 0-6 3.5 4 4 0 0 0 3.5 6 4 4 0 0 0 6 3.5 4 4 0 0 0 6-3.5 4 4 0 0 0 3.5-6 4 4 0 0 0-3.5-6 4 4 0 0 0-6-3.5z"/><circle cx="12" cy="12" r="2.5" fill="#ffffff"/></svg>
          </div>
          <div class="brand-info">
            <span class="brand-title">HaruDrive</span>
            <span class="brand-subtag">Cloud Storage</span>
          </div>
        </a>
        <div class="status-capsule">
          <span class="pulse-dot"></span>
          <span class="status-text">HF 8TB Online</span>
        </div>
      </div>

      <div class="nav-center">
        <div class="spotlight-search">
          <svg class="icon spotlight-icon icon-sm" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="searchInput" placeholder="Cari file & media..." autocomplete="off">
          <span class="shortcut-badge">Ctrl K</span>
        </div>
      </div>

      <div class="nav-right">
        <button class="nav-btn" id="refreshBtn" title="Refresh File">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
        </button>

        <a href="/admin" class="nav-btn btn-admin-nav" title="Buka Console Admin">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span class="btn-text-label">Admin</span>
        </a>

        <button class="nav-btn" id="darkToggle" title="Ganti Tema">
          <svg class="icon icon-sm" id="themeIcon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>

        <a href="/logout" class="nav-btn" title="Keluar">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </a>
      </div>
    </div>
  </header>

  <!-- CATEGORY FILTER -->
  <div class="filter-strip">
    <div class="filter-container">
      <button class="filter-chip active" data-filter="all">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
        <span>Semua File</span>
      </button>
      <button class="filter-chip" data-filter="video">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
        <span>Video & Film</span>
      </button>
      <button class="filter-chip" data-filter="folder">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <span>Direktori</span>
      </button>
      <button class="filter-chip" data-filter="archive">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
        <span>Archive (ZIP/RAR)</span>
      </button>
      <button class="filter-chip" data-filter="document">
        <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <span>Dokumen</span>
      </button>
    </div>
  </div>

  <!-- MAIN VIEW -->
  <main class="container">
    <div class="breadcrumb-bar glass">
      <div class="crumb-group" id="breadcrumbNav">
        <a href="/" class="crumb" onclick="navigateTo('/'); return false;">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>Home</span>
        </a>
      </div>
    </div>

    <div class="file-table-wrapper glass">
      <div class="table-header">
        <div class="col-cb"><input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll(this.checked)"></div>
        <div class="col-name">Nama File / Folder</div>
        <div class="col-size">Ukuran</div>
        <div class="col-date">Diperbarui</div>
        <div class="col-actions">Aksi</div>
      </div>
      <div id="fileListContainer">
        <div style="text-align: center; padding: 40px; color: var(--text-muted);">
          <div class="pulse-dot" style="margin: 0 auto 12px; width: 12px; height: 12px;"></div>
          <p>Menghubungkan ke HaruDrive Storage...</p>
        </div>
      </div>
    </div>
  </main>

  <!-- FLOATING BULK TOOLBAR (PUBLIC) -->
  <div id="bulkToolbar" class="bulk-toolbar" style="display: none;">
    <span id="bulkCount" class="bulk-count-badge">0 Dipilih</span>
    <button class="btn-bulk" onclick="bulkCopyLinks()">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      <span>Salin</span>
    </button>
    <button class="btn-bulk-close" onclick="clearBulkSelection()" title="Batal Pilih">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
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
        <a href="/" class="nav-btn" title="Kembali ke Web Publik">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span class="btn-text-label">Web Publik</span>
        </a>

        <button class="nav-btn" style="background: rgba(239, 68, 68, 0.12); border-color: rgba(239, 68, 68, 0.35); color: #ef4444;" onclick="lockAdminSession()" title="Kunci Mode Admin">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span class="btn-text-label">Kunci Admin</span>
        </button>

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
        <input type="text" id="gatePinInput" inputmode="numeric" placeholder="••••••" maxlength="10" autocomplete="off" data-lpignore="true" data-1p-ignore="true" class="form-input-pro pin-input-stealth">
        <button class="nav-btn" style="width: 100%; justify-content: center; padding: 12px; background: var(--accent-gradient); color: white; border: none; font-size: 0.95rem; font-weight: 700;" onclick="unlockAdminConsole()">Buka Console Admin</button>
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
        <button class="btn-action-tool" style="background: rgba(99, 102, 241, 0.15); border-color: rgba(99, 102, 241, 0.4); color: var(--primary-light);" onclick="openUploadModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <span>Upload File</span>
        </button>

        <button class="btn-action-tool" style="background: rgba(16, 185, 129, 0.12); border-color: rgba(16, 185, 129, 0.35); color: #10b981;" onclick="openNewFolderModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg>
          <span>Folder Baru</span>
        </button>

        <button class="btn-action-tool" style="background: rgba(236, 72, 153, 0.12); border-color: rgba(236, 72, 153, 0.35); color: #ec4899;" onclick="openMirrorModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><polyline points="12 13 12 7 9 10"/><polyline points="12 7 15 10"/></svg>
          <span>Cloud Mirror</span>
        </button>

        <button class="btn-action-tool" style="background: rgba(14, 165, 233, 0.12); border-color: rgba(14, 165, 233, 0.35); color: #0ea5e9; position: relative;" onclick="openTaskManagerModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/></svg>
          <span>Task Manager</span>
          <span id="taskPulseDot" style="display: none; width: 7px; height: 7px; border-radius: 50%; background: #10b981; box-shadow: 0 0 8px #10b981; position: absolute; top: 4px; right: 4px;"></span>
        </button>

        <button class="btn-action-tool" onclick="loadFolder(currentPath, currentFolderId)" title="Refresh">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          <span>Refresh</span>
        </button>
      </div>
    </div>

    <!-- Table -->
    <div class="file-table-wrapper glass">
      <div class="table-header">
        <div class="col-cb"><input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll(this.checked)"></div>
        <div class="col-name">Nama File / Folder</div>
        <div class="col-size">Ukuran</div>
        <div class="col-date">Diperbarui</div>
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
