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

    // ==========================================================
    // API: Realtime Global Search (D1 Database)
    // ==========================================================
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

    // ==========================================================
    // API: List Folder Files from Hugging Face + D1 Indexing
    // ==========================================================
    if (url.pathname === '/api/list') {
      try {
        let reqPath = url.searchParams.get('path') || '';
        const folderId = url.searchParams.get('id') || '';

        // Resolve Short ID if passed
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

        // Batch save to D1 for shortlink resolution
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

        // Get current folder ID
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

    // ==========================================================
    // API: Realtime Mirror Status (Live In-Web Progress)
    // ==========================================================
    if (url.pathname === '/api/admin/mirror/status') {
      try {
        const pat = GITHUB_PAT;
        const repo = GITHUB_REPO;
        if (!pat) {
          return new Response(JSON.stringify({ error: 'GITHUB_PAT not configured' }), { status: 500 });
        }

        const ghRes = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/mirror.yml/runs?per_page=1`, {
          headers: {
            'Authorization': `Bearer ${pat}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'HaruDrive-Admin'
          }
        });

        if (!ghRes.ok) {
          return new Response(JSON.stringify({ error: `GitHub API error (${ghRes.status})` }), { status: ghRes.status });
        }

        const data = await ghRes.json();
        const runs = data.workflow_runs || [];
        if (runs.length === 0) {
          return new Response(JSON.stringify({ status: 'idle', hasActiveRun: false }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        const latestRun = runs[0];
        const isActive = latestRun.status === 'in_progress' || latestRun.status === 'queued';
        let stepName = 'Memulai runner cloud...';
        let progressPercent = 15;

        if (latestRun.jobs_url && isActive) {
          try {
            const jobsRes = await fetch(latestRun.jobs_url, {
              headers: {
                'Authorization': `Bearer ${pat}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'HaruDrive-Admin'
              }
            });
            if (jobsRes.ok) {
              const jobsData = await jobsRes.json();
              const mainJob = (jobsData.jobs || [])[0];
              if (mainJob && mainJob.steps) {
                const currentStep = mainJob.steps.find(s => s.status === 'in_progress') || mainJob.steps.slice().reverse().find(s => s.status === 'completed');
                if (currentStep) {
                  stepName = currentStep.name;
                  const totalSteps = mainJob.steps.length;
                  const stepIndex = mainJob.steps.indexOf(currentStep) + 1;
                  progressPercent = Math.min(95, Math.max(15, Math.round((stepIndex / totalSteps) * 100)));
                }
              }
            }
          } catch (e) {}
        }

        return new Response(JSON.stringify({
          status: latestRun.conclusion || latestRun.status,
          hasActiveRun: isActive,
          runId: latestRun.id,
          htmlUrl: latestRun.html_url,
          createdAt: latestRun.created_at,
          updatedAt: latestRun.updated_at,
          stepName: stepName,
          progressPercent: isActive ? progressPercent : (latestRun.conclusion === 'success' ? 100 : 0)
        }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // ==========================================================
    // API: Start Cloud Mirror (GitHub Actions Dispatch)
    // ==========================================================
    if (url.pathname === '/api/admin/mirror' && request.method === 'POST') {
      try {
        const body = await request.json();
        const pin = body.admin_pin || '';
        if (pin !== ADMIN_PIN) {
          return new Response(JSON.stringify({ error: 'PIN Admin Salah! Akses ditolak.' }), { status: 403 });
        }

        const gdriveUrl = (body.gdrive_url || '').trim();
        const targetPath = (body.target_path || '').trim();
        if (!gdriveUrl) {
          return new Response(JSON.stringify({ error: 'GDRIVE_URL wajib diisi.' }), { status: 400 });
        }

        const pat = GITHUB_PAT;
        const repo = GITHUB_REPO;
        const ghRes = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${pat}`,
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
            message: '🚀 Cloud Mirror berhasil dijalankan!',
            repo: repo,
            target_path: targetPath
          }), { headers: { 'Content-Type': 'application/json' } });
        } else {
          const errText = await ghRes.text();
          return new Response(JSON.stringify({ error: `GitHub dispatch failed (${ghRes.status}): ${errText}` }), { status: ghRes.status });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // ==========================================================
    // API: Admin File Manager (New Folder / Mkdir)
    // ==========================================================
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

        const keepFileUrl = `https://huggingface.co/api/datasets/${HF_REPO_ID}/raw/main/${encodeURI(folderPath)}/.gitkeep`;
        const hfRes = await fetch(keepFileUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${HF_TOKEN}`,
            'Content-Type': 'text/plain'
          },
          body: ''
        });

        if (!hfRes.ok && hfRes.status !== 201 && hfRes.status !== 200) {
          const errText = await hfRes.text();
          return new Response(JSON.stringify({ error: `Gagal membuat folder di HF: ${errText}` }), { status: hfRes.status });
        }

        // Save folder to D1
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

    // ==========================================================
    // API: Admin File Manager (Delete Files / Folders)
    // ==========================================================
    if (url.pathname === '/api/admin/delete' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (body.admin_pin !== ADMIN_PIN) {
          return new Response(JSON.stringify({ error: 'PIN Admin Salah!' }), { status: 403 });
        }

        const paths = body.paths || (body.path ? [body.path] : []);
        if (!paths.length) {
          return new Response(JSON.stringify({ error: 'Tidak ada path yang dipilih untuk dihapus.' }), { status: 400 });
        }

        let deletedCount = 0;
        for (const filePath of paths) {
          const cleanPath = filePath.replace(/^\/+|\/+$/g, '');
          const hfDeleteUrl = `https://huggingface.co/api/datasets/${HF_REPO_ID}/raw/main/${encodeURI(cleanPath)}`;
          try {
            const hfRes = await fetch(hfDeleteUrl, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${HF_TOKEN}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ commit_message: `Delete ${cleanPath} via HaruDrive` })
            });
            if (hfRes.ok || hfRes.status === 200 || hfRes.status === 204) {
              deletedCount++;
              if (env.harudrive_db) {
                await env.harudrive_db.prepare('DELETE FROM shortlinks WHERE file_path = ? OR file_path LIKE ?')
                  .bind(cleanPath, `${cleanPath}/%`).run();
              }
            }
          } catch (e) {
            console.error('Delete error for', cleanPath, e);
          }
        }

        return new Response(JSON.stringify({ success: true, deletedCount }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // ==========================================================
    // Clean Shortlink File & Download Handler (/file/:id, /d/:id, /raw/:id)
    // ==========================================================
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

      // Fallback: direct path if not resolved by short ID
      if (!filePath) {
        filePath = decodeURIComponent(pathAfterPrefix);
        fileName = filePath.split('/').pop() || 'file';
      }

      const hfFileUrl = `https://huggingface.co/datasets/${HF_REPO_ID}/resolve/main/${encodeURI(filePath)}`;
      const hfHeaders = new Headers();
      if (HF_TOKEN) hfHeaders.set('Authorization', `Bearer ${HF_TOKEN}`);

      // Pass Range Header for video seek
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

    // ==========================================================
    // Render Application Single-Page UI
    // ==========================================================
    if (url.pathname === '/' || url.pathname.startsWith('/folder/')) {
      return new Response(htmlPage(mainUI(), env), {
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }

    // Fallback static assets or redirect
    return new Response(htmlPage(mainUI(), env), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }
};

// ==========================================================
// Helper Functions
// ==========================================================
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

// ==========================================================
// HTML Page Generator with Plyr.js & Crisp Vector SVG Icons
// ==========================================================
function htmlPage(content, env) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>HaruDrive - High-Speed Cloud Storage Index</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%23ec4899%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6%22/></svg>">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
  
  <!-- Plyr.js Video Player CSS & JS -->
  <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css" />
  <script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>

  <style>
    :root {
      --primary: #6366f1;
      --primary-light: #818cf8;
      --accent: #ec4899;
      --accent-gradient: linear-gradient(135deg, #ec4899 0%, #a855f7 50%, #6366f1 100%);
      --bg: #090d16;
      --bg-surface: rgba(17, 24, 39, 0.78);
      --bg-card: rgba(22, 30, 49, 0.88);
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

    /* PURE FLAWLESS LIGHT THEME */
    body.light {
      --bg: #f8fafc;
      --bg-surface: rgba(255, 255, 255, 0.92);
      --bg-card: #ffffff;
      --border: #e2e8f0;
      --border-focus: #ec4899;
      --text: #0f172a;
      --text-muted: #475569;
      --text-dim: #64748b;
      --hover-row: rgba(99, 102, 241, 0.05);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font);
      background-color: var(--bg);
      background-image: radial-gradient(at 0% 0%, rgba(236, 72, 153, 0.12) 0px, transparent 45%),
                        radial-gradient(at 100% 0%, rgba(99, 102, 241, 0.12) 0px, transparent 45%),
                        radial-gradient(at 50% 100%, rgba(168, 85, 247, 0.08) 0px, transparent 50%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      transition: background 0.25s, color 0.25s;
    }

    body.modal-open {
      overflow: hidden !important;
    }

    .glass {
      background: var(--bg-surface);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border);
    }

    /* SVG Icon Helpers */
    .icon {
      width: 18px;
      height: 18px;
      stroke-width: 2;
      stroke: currentColor;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
      flex-shrink: 0;
    }
    .icon-sm { width: 14px; height: 14px; }
    .icon-lg { width: 22px; height: 22px; }

    /* NAVBAR */
    .navbar-cyber {
      position: sticky;
      top: 0;
      z-index: 100;
      border-bottom: 1px solid var(--border);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.08);
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
    }
    .logo-glow-wrap {
      width: 38px;
      height: 38px;
      border-radius: 12px;
      background: rgba(236, 72, 153, 0.15);
      border: 1px solid rgba(236, 72, 153, 0.35);
      color: #ec4899;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 15px rgba(236, 72, 153, 0.25);
      transition: transform 0.2s;
    }
    .brand-logo:hover .logo-glow-wrap {
      transform: scale(1.08) rotate(6deg);
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
    .status-text {
      font-size: 0.72rem;
      font-weight: 700;
      color: #10b981;
    }

    /* SEARCH SPOTLIGHT */
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
    body.light .spotlight-search {
      background: #f1f5f9;
      border-color: #cbd5e1;
    }
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

    /* BUTTONS */
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
    }
    .nav-btn:hover {
      border-color: var(--primary-light);
      background: rgba(99, 102, 241, 0.12);
      transform: translateY(-1px);
    }
    .btn-mirror-stealth {
      background: rgba(236, 72, 153, 0.12);
      border-color: rgba(236, 72, 153, 0.35);
      color: #ec4899;
    }
    .btn-admin-badge {
      background: rgba(16, 185, 129, 0.12);
      border-color: rgba(16, 185, 129, 0.35);
      color: #10b981;
    }

    /* FILTER STRIP */
    .filter-strip {
      padding: 8px 24px;
      background: rgba(11, 15, 25, 0.35);
      border-top: 1px solid var(--border);
      overflow-x: auto;
    }
    body.light .filter-strip {
      background: #f1f5f9;
    }
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
    .filter-chip:hover {
      color: var(--text);
      border-color: var(--primary-light);
    }
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

    /* BREADCRUMB & TOOLBAR */
    .breadcrumb-bar {
      padding: 10px 18px;
      border-radius: var(--radius);
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
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
    }
    .btn-action-tool {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 12px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text);
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-action-tool:hover {
      border-color: var(--primary-light);
      background: rgba(99, 102, 241, 0.12);
    }

    /* FILE TABLE */
    .file-table-wrapper {
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
    }
    body.light .file-table-wrapper {
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
    }
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
    .col-cb { width: 34px; display: flex; align-items: center; }
    .col-name { flex: 1; min-width: 0; }
    .col-size { width: 110px; text-align: right; }
    .col-date { width: 140px; text-align: right; }
    .col-actions { width: 220px; text-align: right; }

    .file-row {
      display: flex;
      align-items: center;
      padding: 11px 18px;
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
    }
    .file-icon-box {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      background: rgba(99, 102, 241, 0.1);
      color: var(--primary-light);
    }
    .file-icon-box.folder {
      background: rgba(245, 158, 11, 0.12);
      color: #f59e0b;
    }
    .file-icon-box.video {
      background: rgba(236, 72, 153, 0.12);
      color: #ec4899;
    }
    .file-icon-box.archive {
      background: rgba(168, 85, 247, 0.12);
      color: #a855f7;
    }

    .file-title {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-row.is-folder .file-title { color: var(--primary-light); }

    .file-size-cell, .file-date-cell {
      font-size: 0.8rem;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
    }
    .file-size-cell { width: 110px; text-align: right; }
    .file-date-cell { width: 140px; text-align: right; }

    .file-actions-cell {
      width: 220px;
      display: flex;
      justify-content: flex-end;
      gap: 6px;
    }
    .btn-act {
      padding: 5px 9px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-card);
      color: var(--text);
      font-size: 0.78rem;
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
      background: rgba(236, 72, 153, 0.12);
      border-color: rgba(236, 72, 153, 0.3);
      color: #ec4899;
    }
    .btn-act.play:hover {
      background: #ec4899;
      color: white;
    }
    .btn-act.btn-delete {
      color: #ef4444;
      border-color: rgba(239, 68, 68, 0.25);
    }
    .btn-act.btn-delete:hover {
      background: #ef4444;
      color: white;
    }

    /* BULK TOOLBAR */
    .bulk-toolbar {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 20px;
      border-radius: 30px;
      box-shadow: 0 10px 35px rgba(0,0,0,0.5);
      z-index: 90;
      background: var(--bg-card);
      border: 1px solid var(--border);
      animation: modalPop 0.25s ease-out;
    }
    .btn-bulk {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 20px;
      border: 1px solid var(--border);
      font-weight: 600;
      font-size: 0.84rem;
      cursor: pointer;
      background: var(--bg-surface);
      color: var(--text);
      transition: all 0.2s;
    }
    .btn-bulk.danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.4);
      color: #ef4444;
    }
    .btn-bulk.danger:hover {
      background: #ef4444;
      color: white;
    }

    /* MODAL SYSTEM & PLYR FIXES */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(5, 8, 16, 0.85);
      backdrop-filter: blur(14px);
      -webkit-backdrop-filter: blur(14px);
      z-index: 2000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .modal-card {
      width: 100%;
      max-width: 560px;
      border-radius: 20px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6);
      overflow: hidden;
      animation: modalPop 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes modalPop {
      0% { opacity: 0; transform: scale(0.95) translateY(10px); }
      100% { opacity: 1; transform: scale(1) translateY(0); }
    }
    .video-card {
      max-width: 920px;
      border-radius: 18px;
    }
    .video-container-wrap {
      width: 100%;
      background: #000;
      overflow: hidden;
      aspect-ratio: 16 / 9;
    }
    .plyr--video {
      height: 100%;
      width: 100%;
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
    }
    .modal-title {
      font-size: 1.1rem;
      font-weight: 700;
      color: var(--text);
    }
    .btn-close-circle {
      width: 30px;
      height: 30px;
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
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .modal-footer {
      padding: 14px 20px;
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

    .external-players-row {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .btn-ext-player {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 6px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-surface);
      color: var(--text);
      font-size: 0.78rem;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.2s;
    }
    .btn-ext-player:hover {
      border-color: var(--primary-light);
      background: rgba(99, 102, 241, 0.12);
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
      .container { padding: 0 10px; margin: 12px auto; }
      .col-date, .file-date-cell { display: none; }
      .col-size { width: 75px; }
      .file-size-cell { width: 75px; }
      .col-actions { width: 90px; }
      .file-actions-cell { width: 90px; gap: 4px; }
      .btn-act .btn-act-label { display: none; }
      .btn-act { padding: 5px 7px; }
      .file-row { padding: 10px; }
      .file-title { font-size: 0.85rem; }
      .col-cb { width: 28px; }
      .bulk-toolbar { width: calc(100% - 24px); padding: 8px 14px; border-radius: 16px; }
      .modal-backdrop { padding: 0; align-items: flex-end; }
      .modal-card { max-width: 100%; border-radius: 20px 20px 0 0; }
    }
    @media (max-width: 480px) {
      .col-size, .file-size-cell { display: none; }
      .col-actions { width: 75px; }
      .file-actions-cell { width: 75px; }
    }
  </style>
</head>
<body>
  ${content}
  <script>
let currentPath = '';
let currentFolderId = '';
let allFiles = [];
let activeFilter = 'all';
let selectedFiles = new Set();
let plyrPlayerInstance = null;
let isAdminActive = false;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Theme check
  if (localStorage.getItem('haruTheme') === 'light') {
    document.body.classList.add('light');
    updateThemeIcon(true);
  }

  // Admin PIN check
  if (localStorage.getItem('harudrive_admin_pin')) {
    setAdminState(true);
  }

  // Setup Event Listeners
  document.getElementById('darkToggle')?.addEventListener('click', toggleTheme);
  document.getElementById('refreshBtn')?.addEventListener('click', () => loadFolder(currentPath, currentFolderId));
  document.getElementById('mirrorModalBtn')?.addEventListener('click', openMirrorModal);
  document.getElementById('adminToggleBtn')?.addEventListener('click', toggleAdminMode);
  
  // Filter chips
  document.querySelectorAll('.filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.getAttribute('data-filter') || 'all';
      renderFileList();
    });
  });

  // Spotlight search
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(handleSearch, 300));
  }

  // Keyboard shortcut Ctrl+K
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      searchInput?.focus();
    }
  });

  // History Popstate
  window.addEventListener('popstate', handlePopState);

  // Initial Route Check
  const pathName = window.location.pathname;
  if (pathName.startsWith('/folder/')) {
    const fId = pathName.replace('/folder/', '').split('/')[0];
    loadFolder('', fId);
  } else {
    const urlParams = new URLSearchParams(window.location.search);
    const p = urlParams.get('p') || '';
    loadFolder(p, '');
  }
});

// Navigation
function navigateTo(path, id = '', pushHistory = true) {
  if (pushHistory) {
    const targetUrl = id ? \`/folder/\${id}\` : (path ? \`/?p=\${encodeURIComponent(path)}\` : '/');
    window.history.pushState({ path, id }, '', targetUrl);
  }
  loadFolder(path, id);
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
          <p>Gagal memuat folder: \${err.message}</p>
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

    const fileShortLink = \`/file/\${file.id}\`;
    const downloadShortLink = \`/d/\${file.id}\`;

    html += \`
    <div class="file-row \${isDir ? 'is-folder' : ''}">
      <div class="col-cb">
        <input type="checkbox" \${isChecked ? 'checked' : ''} onchange="toggleItemSelect('\${escapeJs(file.path)}', this.checked)">
      </div>
      <div class="file-name-cell" onclick="\${isDir ? \`navigateTo('\${escapeJs(file.path)}', '\${file.id}')\` : (isVideo ? \`playVideo('\${file.id}', '\${escapeJs(file.name)}')\` : \`downloadFile('\${file.id}')\`)}">
        <div class="file-icon-box \${iconType}">
          \${getFileSvgIcon(iconType)}
        </div>
        <span class="file-title" title="\${escapeHtml(file.name)}">\${escapeHtml(file.name)}</span>
      </div>
      <div class="file-size-cell">\${isDir ? '-' : formatBytes(file.size)}</div>
      <div class="file-date-cell">\${formatDate(file.modifiedTime)}</div>
      <div class="file-actions-cell">
        \${isVideo ? \`
          <button class="btn-act play" onclick="playVideo('\${file.id}', '\${escapeJs(file.name)}')" title="Putar Video">
            <svg class="icon icon-sm" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <span class="btn-act-label">Play</span>
          </button>
        \` : ''}
        \${!isDir ? \`
          <a class="btn-act" href="\${downloadShortLink}" title="Download">
            <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </a>
          <button class="btn-act" onclick="copyShortLink('\${file.id}')" title="Salin Shortlink">
            <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          </button>
        \` : ''}
        \${isAdminActive ? \`
          <button class="btn-act btn-delete" onclick="deleteSingleItem('\${escapeJs(file.path)}')" title="Hapus">
            <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        \` : ''}
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
    <a href="/" class="crumb" onclick="navigateTo(''); return false;">
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
        html += \`<a href="/?p=\${encodeURIComponent(accum)}" class="crumb" onclick="navigateTo('\${escapeJs(accum)}'); return false;">\${escapeHtml(p)}</a>\`;
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

  // External Player Deep Links
  extEl.innerHTML = \`
    <a href="vlc://\${streamUrl}" class="btn-ext-player" title="Buka di VLC">VLC</a>
    <a href="potplayer://\${streamUrl}" class="btn-ext-player" title="Buka di PotPlayer">PotPlayer</a>
    <a href="iina://weblink?url=\${encodeURIComponent(streamUrl)}" class="btn-ext-player" title="Buka di IINA">IINA</a>
    <a href="intent:\${streamUrl}#Intent;package=com.mxtech.videoplayer.ad;type=video/*;end" class="btn-ext-player" title="Buka di MX Player">MX Player</a>
    <a href="/d/\${shortId}" class="btn-ext-player" style="margin-left: auto; background: var(--primary); color: white; border: none;">Download File</a>
  \`;

  // Destroy previous Plyr instance
  if (plyrPlayerInstance) {
    try { plyrPlayerInstance.destroy(); } catch (e) {}
  }

  videoEl.src = streamUrl;
  modal.style.display = 'flex';
  document.body.classList.add('modal-open');

  // Init Plyr
  if (window.Plyr) {
    plyrPlayerInstance = new Plyr(videoEl, {
      autoplay: true,
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

// Shortlink Copy
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

// Admin Mode
function toggleAdminMode() {
  if (isAdminActive) {
    setAdminState(false);
  } else {
    const savedPin = localStorage.getItem('harudrive_admin_pin');
    if (savedPin) {
      setAdminState(true);
    } else {
      openAdminAuthModal();
    }
  }
}

function setAdminState(active) {
  isAdminActive = active;
  const btn = document.getElementById('adminToggleBtn');
  const btnText = document.getElementById('adminBtnText');
  const toolbar = document.getElementById('adminToolbar');

  if (btn) {
    if (active) {
      btn.className = 'nav-btn btn-admin-badge';
      if (btnText) btnText.textContent = 'Admin On';
    } else {
      btn.className = 'nav-btn';
      if (btnText) btnText.textContent = 'Admin';
    }
  }
  if (toolbar) toolbar.style.display = active ? 'flex' : 'none';
  renderFileList();
}

function openAdminAuthModal() {
  const m = document.getElementById('adminAuthModal');
  if (m) {
    m.style.display = 'flex';
    document.getElementById('adminPinInput')?.focus();
  }
}

function closeAdminAuthModal() {
  const m = document.getElementById('adminAuthModal');
  if (m) m.style.display = 'none';
}

function verifyAdminPin() {
  const pinInput = document.getElementById('adminPinInput');
  const rememberCb = document.getElementById('rememberAdminPin');
  const pin = (pinInput?.value || '').trim();

  if (pin === '290722') {
    if (rememberCb && rememberCb.checked) {
      localStorage.setItem('harudrive_admin_pin', pin);
    }
    setAdminState(true);
    closeAdminAuthModal();
    alert('✅ Mode Admin Berhasil Diaktifkan!');
  } else {
    alert('❌ PIN Admin Salah!');
    pinInput?.focus();
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

  const pin = localStorage.getItem('harudrive_admin_pin') || '290722';
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
    } else {
      alert('Gagal: ' + (data.error || 'Terjadi kesalahan'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

// Single Item Delete
async function deleteSingleItem(itemPath) {
  if (!confirm(\`Yakin ingin menghapus permanent:\\n\${itemPath}?\`)) return;
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
    if (countEl) countEl.textContent = \`\${selectedFiles.size} Item Dipilih\`;
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
  const pin = localStorage.getItem('harudrive_admin_pin') || '290722';

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
function openMirrorModal() {
  const m = document.getElementById('mirrorModal');
  if (m) m.style.display = 'flex';
}
function closeMirrorModal() {
  const m = document.getElementById('mirrorModal');
  if (m) m.style.display = 'none';
}
async function submitCloudMirror() {
  const urlInput = document.getElementById('mirrorGdriveUrl');
  const targetInput = document.getElementById('mirrorTargetPath');
  const gdriveUrl = (urlInput?.value || '').trim();
  const targetPath = (targetInput?.value || '').trim();
  if (!gdriveUrl) return alert('Masukkan URL Google Drive!');

  const pin = localStorage.getItem('harudrive_admin_pin') || prompt('Masukkan PIN Admin (290722):');
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
      alert('🚀 Cloud Mirror Runner berhasil dijalankan di GitHub Actions!');
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

// SVG Icons
function getFileSvgIcon(type) {
  if (type === 'folder') {
    return '<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
  }
  if (type === 'video') {
    return '<svg class="icon icon-sm" viewBox="0 0 24 24"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
  }
  if (type === 'archive') {
    return '<svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>';
  }
  return '<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
}

// Helpers
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
      <div class="logo-glow-wrap" style="margin: 0 auto 16px; width: 56px; height: 56px; font-size: 1.8rem;">
        <svg class="icon icon-lg" viewBox="0 0 24 24"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      </div>
      <h2 style="font-size: 1.6rem; font-weight: 800; margin-bottom: 6px; background: var(--accent-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">HaruDrive Index</h2>
      <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 24px;">Masukkan password untuk mengakses storage cloud.</p>
      
      ${errorMsg ? `<div style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; padding: 10px; border-radius: 10px; font-size: 0.85rem; margin-bottom: 18px;">${errorMsg}</div>` : ''}

      <form method="POST" action="/login" style="display: flex; flex-direction: column; gap: 14px;">
        <input type="password" name="password" placeholder="Password Akses..." required autofocus class="form-input-pro" style="padding: 12px 16px; font-size: 1rem; text-align: center;">
        <button type="submit" class="nav-btn" style="width: 100%; justify-content: center; padding: 12px; background: var(--accent-gradient); color: white; border: none; font-size: 0.95rem; font-weight: 700; border-radius: 12px;">Buka HaruDrive</button>
      </form>
    </div>
  </div>`;
}

function mainUI() {
  return `
  <!-- TOP NAVBAR -->
  <header class="navbar-cyber glass">
    <div class="nav-container">
      <div class="nav-left">
        <a href="/" class="brand-logo" id="logoLink">
          <div class="logo-glow-wrap">
            <svg class="icon icon-lg" viewBox="0 0 24 24"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
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

        <button class="nav-btn btn-mirror-stealth" id="mirrorModalBtn" title="Cloud Mirror Engine">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><polyline points="12 13 12 7 9 10"/><polyline points="12 7 15 10"/></svg>
          <span class="btn-text-label">Mirror</span>
        </button>

        <button class="nav-btn" id="adminToggleBtn" title="Mode Admin File Manager">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span class="btn-text-label" id="adminBtnText">Admin</span>
        </button>

        <button class="nav-btn" id="darkToggle" title="Ganti Tema">
          <svg class="icon icon-sm" id="themeIcon" viewBox="0 0 24 24"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
        </button>

        <a href="/logout" class="nav-btn" title="Keluar">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </a>
      </div>
    </div>
  </header>

  <!-- SUBHEADER CATEGORY FILTER -->
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
    <!-- Breadcrumb Toolbar -->
    <div class="breadcrumb-bar glass">
      <div class="crumb-group" id="breadcrumbNav">
        <a href="/" class="crumb" onclick="navigateTo('/'); return false;">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>Home</span>
        </a>
      </div>

      <div class="toolbar-actions" id="adminToolbar" style="display: none;">
        <button class="btn-action-tool" onclick="openNewFolderModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>
          <span>+ Folder Baru</span>
        </button>
      </div>
    </div>

    <!-- File Table -->
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

  <!-- FLOATING BULK ACTIONS TOOLBAR -->
  <div id="bulkToolbar" class="bulk-toolbar" style="display: none;">
    <span id="bulkCount" style="font-size: 0.85rem; font-weight: 700;">0 Dipilih</span>
    <button class="btn-bulk danger" onclick="bulkDeleteSelected()">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
      <span>Hapus</span>
    </button>
    <button class="btn-bulk" onclick="bulkCopyLinks()">
      <svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      <span>Salin Link</span>
    </button>
    <button class="btn-bulk" onclick="clearBulkSelection()">Batal</button>
  </div>

  <!-- PLYR VIDEO MODAL -->
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
      <div class="modal-body" style="padding: 14px 20px;">
        <div style="font-size: 0.78rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase;">Buka di External Player:</div>
        <div class="external-players-row" id="externalPlayersContainer"></div>
      </div>
    </div>
  </div>

  <!-- ADMIN AUTH MODAL -->
  <div id="adminAuthModal" class="modal-backdrop" style="display: none;">
    <div class="modal-card">
      <div class="modal-header">
        <span class="modal-title">🔐 Buka Mode Admin File Manager</span>
        <button class="btn-close-circle" onclick="closeAdminAuthModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <p style="font-size: 0.86rem; color: var(--text-muted);">Masukkan 6-digit PIN Admin Anda untuk mengaktifkan fitur Buat Folder, Rename, dan Hapus:</p>
        <input type="password" id="adminPinInput" class="form-input-pro" placeholder="Masukkan PIN Admin (290722)" maxlength="10" style="text-align: center; font-size: 1.2rem; letter-spacing: 4px;">
        <label style="display: flex; align-items: center; gap: 8px; font-size: 0.84rem; cursor: pointer;">
          <input type="checkbox" id="rememberAdminPin" checked>
          <span>Ingat PIN Admin di browser ini</span>
        </label>
      </div>
      <div class="modal-footer">
        <button class="nav-btn" onclick="closeAdminAuthModal()">Batal</button>
        <button class="nav-btn" style="background: var(--accent-gradient); color: white; border: none;" onclick="verifyAdminPin()">Aktifkan Admin</button>
      </div>
    </div>
  </div>

  <!-- NEW FOLDER MODAL -->
  <div id="newFolderModal" class="modal-backdrop" style="display: none;">
    <div class="modal-card">
      <div class="modal-header">
        <span class="modal-title">📁 Buat Folder Baru</span>
        <button class="btn-close-circle" onclick="closeNewFolderModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <label style="font-size: 0.85rem; font-weight: 600;">Nama Folder:</label>
        <input type="text" id="newFolderNameInput" class="form-input-pro" placeholder="contoh: Drama 2026 atau Anime">
      </div>
      <div class="modal-footer">
        <button class="nav-btn" onclick="closeNewFolderModal()">Batal</button>
        <button class="nav-btn" style="background: var(--primary); color: white; border: none;" onclick="submitNewFolder()">Buat Folder</button>
      </div>
    </div>
  </div>

  <!-- CLOUD MIRROR MODAL -->
  <div id="mirrorModal" class="modal-backdrop" style="display: none;">
    <div class="modal-card">
      <div class="modal-header">
        <span class="modal-title">⚡ Cloud Mirror Runner</span>
        <button class="btn-close-circle" onclick="closeMirrorModal()">
          <svg class="icon icon-sm" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-body">
        <label style="font-size: 0.84rem; font-weight: 600;">Google Drive URL / Folder Link:</label>
        <input type="text" id="mirrorGdriveUrl" class="form-input-pro" placeholder="https://drive.google.com/drive/folders/...">
        
        <label style="font-size: 0.84rem; font-weight: 600;">Target Folder di HaruDrive:</label>
        <input type="text" id="mirrorTargetPath" class="form-input-pro" placeholder="contoh: VIU/Series atau biarkan kosong">
      </div>
      <div class="modal-footer">
        <button class="nav-btn" onclick="closeMirrorModal()">Batal</button>
        <button class="nav-btn" id="startMirrorBtn" style="background: var(--accent-gradient); color: white; border: none;" onclick="submitCloudMirror()">Mulai Mirror</button>
      </div>
    </div>
  </div>
  `;
}
