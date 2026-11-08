const $ = (id) => document.getElementById(id);

let selectedFileId = null;

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function refreshAuth() {
  const s = await api('/api/auth/status');
  const el = $('authStatus');
  if (s.authenticated) {
    el.textContent = `Connected: ${s.user?.email || 'Google account'}`;
    $('loginBtn').style.display = 'none';
    $('logoutBtn').style.display = '';
  } else if (s.configured) {
    el.textContent = 'Not connected. Click to connect Google Drive.';
    $('loginBtn').style.display = '';
    $('logoutBtn').style.display = 'none';
  } else {
    el.textContent = 'Google OAuth not configured. Set GOOGLE_CLIENT_ID/SECRET in .env (or paste a public Drive file ID).';
    $('loginBtn').style.display = 'none';
    $('logoutBtn').style.display = 'none';
  }
}

$('loginBtn').onclick = () => { window.location.href = '/auth/google'; };
$('logoutBtn').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }); refreshAuth(); };

function extractFileId(input) {
  input = (input || '').trim();
  const m = input.match(/\/d\/([a-zA-Z0-9_-]+)/) || input.match(/id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(input)) return input;
  return null;
}

$('loadFileBtn').onclick = async () => {
  const id = extractFileId($('fileId').value);
  if (!id) { $('fileInfo').textContent = 'Could not parse file ID.'; return; }
  selectedFileId = id;
  try {
    const f = await api('/api/drive/file/' + id);
    $('fileInfo').textContent = `${f.name} (${f.mimeType}, ${f.size ? Math.round(f.size/1024/1024)+'MB' : ''})`;
  } catch (e) {
    $('fileInfo').textContent = 'Could not load metadata (maybe not authenticated). File ID set: ' + id;
  }
};

$('browseBtn').onclick = async () => {
  const list = $('fileList');
  list.style.display = '';
  list.innerHTML = 'Loading...';
  try {
    const data = await api('/api/drive/files');
    if (!data.files || !data.files.length) { list.innerHTML = '<div class="file">No video files found.</div>'; return; }
    list.innerHTML = '';
    for (const f of data.files) {
      const div = document.createElement('div');
      div.className = 'file';
      div.textContent = `${f.name} (${Math.round((f.size||0)/1024/1024)}MB)`;
      div.onclick = () => {
        document.querySelectorAll('.file').forEach(x=>x.classList.remove('selected'));
        div.classList.add('selected');
        selectedFileId = f.id;
        $('fileId').value = f.id;
        $('fileInfo').textContent = `${f.name} (${f.mimeType})`;
      };
      list.appendChild(div);
    }
  } catch (e) {
    list.innerHTML = '<div class="file">Error: ' + e.message + '</div>';
  }
};

$('startBtn').onclick = async () => {
  const id = extractFileId($('fileId').value) || selectedFileId;
  if (!id) { alert('Select or enter a Google Drive file first.'); return; }
  const url = $('fileId').value.trim();
  const isUrl = url.startsWith('http') && !extractFileId(url);
  const body = {
    fileId: isUrl ? null : id,
    url: isUrl ? url : null,
    title: $('title').value.trim() || null,
    setting: $('setting').value,
  };
  try {
    await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('fileId').value = '';
    $('title').value = '';
    loadJobs();
  } catch (e) { alert('Failed: ' + e.message); }
};

async function loadJobs() {
  try {
    const data = await api('/api/jobs');
    const container = $('jobs');
    container.innerHTML = '';
    if (!data.jobs.length) { container.innerHTML = '<p class="muted">No jobs yet.</p>'; return; }
    for (const j of data.jobs) {
      const div = document.createElement('div');
      div.className = 'job';
      const origin = location.origin;
      const streamUrl = origin + j.streamUrl;
      div.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>${escapeHtml(j.title)}</strong>
          <span class="badge ${j.status}">${j.status}</span>
        </div>
        <div class="muted">${j.setting} &middot; ${j.progress ? j.progress.toFixed(1) : 0}%${j.error ? ' &middot; ' + escapeHtml(j.error) : ''}</div>
        <div class="progress"><div style="width:${j.progress||0}%"></div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="secondary" data-copy="${streamUrl}">Copy Stream URL</button>
          <button class="secondary" data-open="${streamUrl}">Open</button>
          <button class="danger" data-del="${j.id}">Delete</button>
        </div>
        <div class="muted" style="margin-top:6px;"><code>${streamUrl}</code></div>
      `;
      container.appendChild(div);
    }
    container.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy); b.textContent='Copied!'; setTimeout(()=>b.textContent='Copy Stream URL',1500); });
    container.querySelectorAll('[data-open]').forEach(b => b.onclick = () => window.open(b.dataset.open, '_blank'));
    container.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (confirm('Delete job?')) { await api('/api/jobs/'+b.dataset.del, { method:'DELETE' }); loadJobs(); } });
  } catch (e) { console.error(e); }
}

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

async function refreshHealth() {
  try {
    const h = await api('/api/health');
    if ($('localIpDisplay')) {
      const ips = (h.localIps && h.localIps.length) ? h.localIps.map(ip => `http://${ip}:${h.port}`).join(' | ') : `http://${location.hostname}:${h.port}`;
      $('localIpDisplay').textContent = ips;
    }
  } catch (_) {}
}

async function refreshActiveStreams() {
  try {
    const data = await api('/api/stream/drive-hls/status');
    const container = $('activeStreams');
    if (!container) return;
    if (!data.activeSessions || !data.activeSessions.length) {
      container.innerHTML = '<span class="muted">No active streams right now. Roku will appear here when playing.</span>';
      return;
    }
    let html = '';
    for (const s of data.activeSessions) {
      const activeFor = Math.round((Date.now() - s.startedAt) / 1000);
      html += `
        <div class="job" style="display:flex; justify-content:space-between; align-items:center;">
          <div>
            <strong>Google Drive Video (${escapeHtml(s.fileId)})</strong>
            <div class="muted">Offset: ${s.offset}s &middot; Active: ${activeFor}s &middot; Transcoding on this PC</div>
          </div>
          <div>
            <button class="danger" onclick="stopStream('${escapeHtml(s.fileId)}')">Stop Stream</button>
          </div>
        </div>
      `;
    }
    container.innerHTML = html;
  } catch (_) {}
}

window.stopStream = async (fileId) => {
  try {
    await api('/api/stream/drive-hls/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId })
    });
    refreshActiveStreams();
  } catch (e) { alert(e.message); }
};

refreshAuth();
refreshHealth();
refreshActiveStreams();
loadJobs();
setInterval(() => {
  loadJobs();
  refreshActiveStreams();
}, 3000);
setInterval(refreshHealth, 10000);
