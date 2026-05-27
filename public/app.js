let token = localStorage.getItem('token');
let ws = null;
let activeServerId = null;
let currentTab = 'overview';

// Charts history
const cpuHistory = [];
const ramHistory = [];
const diskHistory = [];
const maxHistory = 15;

// Process sorting state
let currentProcesses = [];
let sortField = 'cpu';
let sortDesc = true;

function checkAuth() {
  if (token) {
    document.getElementById('loginPage').style.display = 'none';
    document.getElementById('dashboardApp').style.display = 'flex';
    document.getElementById('loginUserInfo').innerText = 'Logged in as admin';
    loadServers();
    connectWebSocket();
  } else {
    document.getElementById('loginPage').style.display = 'flex';
    document.getElementById('dashboardApp').style.display = 'none';
  }
}

async function login() {
  const user = document.getElementById('username').value;
  const pass = document.getElementById('password').value;
  const errDiv = document.getElementById('loginError');
  errDiv.innerText = '';

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    });
    const data = await res.json();
    if (res.ok) {
      token = data.token;
      localStorage.setItem('token', token);
      checkAuth();
    } else {
      errDiv.innerText = data.error || 'Login failed';
    }
  } catch (e) {
    errDiv.innerText = 'Server unreachable';
  }
}

function logout() {
  token = null;
  localStorage.removeItem('token');
  if (ws) ws.close();
  checkAuth();
}

async function loadServers() {
  try {
    const res = await fetch('/api/servers', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.status === 401) return logout();
    const servers = await res.json();
    const list = document.getElementById('serverList');
    list.innerHTML = '';
    servers.forEach(srv => {
      const div = document.createElement('div');
      div.className = `server-item ${activeServerId === srv.id ? 'active' : ''}`;
      div.onclick = () => selectServer(srv.id, srv.name);
      div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <strong>${srv.name}</strong>
          <span class="status-dot status-offline" id="dot-${srv.id}"></span>
        </div>
        <div style="font-size:11px; color:var(--text-secondary);">${srv.host}:${srv.port}</div>
      `;
      list.appendChild(div);
    });
  } catch (err) {
    console.error('Failed to load servers:', err.message);
  }
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws/monitor`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'authenticated') {
      if (activeServerId) {
        requestServerMetrics(activeServerId);
      }
    }

    if (data.type === 'metrics') {
      const dot = document.getElementById(`dot-${data.serverId}`);
      if (dot) {
        dot.className = `status-dot ${data.status === 'online' ? 'status-online' : 'status-offline'}`;
      }

      if (data.serverId === activeServerId) {
        if (data.status === 'online') {
          document.getElementById('activeServerDetails').style.display = 'block';
          document.getElementById('activeServerUptime').innerText = `Uptime: ${data.metrics.uptime}`;
          updateOverviewMetrics(data.metrics);
        } else {
          document.getElementById('activeServerUptime').innerText = `Offline: ${data.error}`;
        }
      }
    }

    if (data.type === 'processes') {
      if (data.serverId === activeServerId) {
        renderProcesses(data.processes);
      }
    }

    if (data.type === 'docker') {
      if (data.serverId === activeServerId) {
        renderDocker(data.containers, data.error);
      }
    }

    if (data.type === 'logs') {
      if (data.serverId === activeServerId) {
        document.getElementById('logConsole').innerText = data.logs;
      }
    }
  };

  ws.onclose = () => {
    setTimeout(connectWebSocket, 3000);
  };
}

function selectServer(id, name) {
  activeServerId = id;
  document.getElementById('activeServerName').innerText = name;
  document.getElementById('btnDeleteServer').style.display = 'block';
  
  // Clear charts history
  cpuHistory.length = 0;
  ramHistory.length = 0;
  diskHistory.length = 0;

  // Clear tab panels UI
  document.getElementById('processesList').innerHTML = '';
  document.getElementById('dockerList').innerHTML = '';
  document.getElementById('logConsole').innerText = '';

  // Update active sidebar class
  document.querySelectorAll('.server-item').forEach(item => {
    item.classList.remove('active');
  });
  loadServers();

  requestServerMetrics(id);
  switchTab(currentTab);
}

function requestServerMetrics(id) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'select-server', serverId: id }));
  }
}

function updateOverviewMetrics(metrics) {
  // CPU usage
  const cpuVal = metrics.cpu;
  document.getElementById('metric-cpu-val').innerText = `${cpuVal.toFixed(1)}%`;
  cpuHistory.push(cpuVal);
  if (cpuHistory.length > maxHistory) cpuHistory.shift();
  drawSparkline('cpuSparkline', cpuHistory, '#06b6d4');

  // RAM memory usage
  const ramVal = metrics.mem.percent;
  const usedGb = (metrics.mem.used / 1024 / 1024 / 1024).toFixed(2);
  const totalGb = (metrics.mem.total / 1024 / 1024 / 1024).toFixed(2);
  document.getElementById('metric-ram-val').innerText = `${ramVal.toFixed(1)}%`;
  document.getElementById('metric-ram-details').innerText = `Used: ${usedGb} GB / Total: ${totalGb} GB`;
  ramHistory.push(ramVal);
  if (ramHistory.length > maxHistory) ramHistory.shift();
  drawSparkline('ramSparkline', ramHistory, '#8b5cf6');

  // Storage usage
  if (metrics.disk.length > 0) {
    const root = metrics.disk[0];
    const diskVal = root.used_percent;
    document.getElementById('metric-disk-val').innerText = `${diskVal}%`;
    document.getElementById('metric-disk-details').innerText = `Avail: ${root.avail} / Total: ${root.size} on ${root.mount}`;
    diskHistory.push(diskVal);
    if (diskHistory.length > maxHistory) diskHistory.shift();
    drawSparkline('diskSparkline', diskHistory, '#eab308');
  }
}

function drawSparkline(canvasId, history, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();

  const step = canvas.width / (maxHistory - 1);
  history.forEach((val, index) => {
    const x = index * step;
    const y = canvas.height - (val / 100) * canvas.height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.style.display = 'none');

  const tabElem = document.getElementById(`tab-${tabName}`);
  if (tabElem) {
    tabElem.classList.add('active');
    tabElem.setAttribute('aria-selected', 'true');
  }
  const panelElem = document.getElementById(`panel-${tabName}`);
  if (panelElem) {
    panelElem.style.display = 'block';
  }

  triggerTabFetch();
}

function triggerTabFetch() {
  if (!activeServerId || !ws || ws.readyState !== WebSocket.OPEN) return;

  if (currentTab === 'processes') {
    ws.send(JSON.stringify({ type: 'fetch-processes' }));
  } else if (currentTab === 'docker') {
    ws.send(JSON.stringify({ type: 'fetch-docker' }));
  }
}

function toggleProcessSort(field) {
  if (sortField === field) {
    sortDesc = !sortDesc;
  } else {
    sortField = field;
    sortDesc = true;
  }
  renderProcesses(currentProcesses);
}

function renderProcesses(processes) {
  currentProcesses = processes;
  const body = document.getElementById('processesList');
  body.innerHTML = '';

  const sorted = [...processes].sort((a, b) => {
    let valA = a[sortField];
    let valB = b[sortField];
    if (typeof valA === 'string') {
      return sortDesc ? valB.localeCompare(valA) : valA.localeCompare(valB);
    }
    return sortDesc ? valB - valA : valA - valB;
  });

  sorted.forEach(p => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border-color)';
    tr.innerHTML = `
      <td style="padding:8px 10px;">${p.pid}</td>
      <td>${p.user}</td>
      <td style="color:var(--accent-cyan);">${p.cpu.toFixed(1)}%</td>
      <td>${p.mem.toFixed(1)}%</td>
      <td style="font-family:monospace; font-size:11px;">${p.command}</td>
    `;
    body.appendChild(tr);
  });
}

function renderDocker(containers, error) {
  const body = document.getElementById('dockerList');
  body.innerHTML = '';
  if (error) {
    body.innerHTML = `<tr><td colspan="3" style="color:var(--accent-red); padding:10px;">${error}</td></tr>`;
    return;
  }
  containers.forEach(c => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border-color)';
    tr.innerHTML = `
      <td style="padding:8px 10px;"><strong>${c.name}</strong></td>
      <td style="color:var(--accent-cyan);">${c.cpu}</td>
      <td>${c.mem}</td>
    `;
    body.appendChild(tr);
  });
}

function updateLogPlaceholder() {
  const type = document.getElementById('logSourceType').value;
  const input = document.getElementById('logPath');
  if (type === 'service') {
    input.placeholder = 'e.g. nginx';
  } else {
    input.placeholder = 'e.g. /var/log/syslog';
  }
}

function fetchLogs() {
  const type = document.getElementById('logSourceType').value;
  const pathVal = document.getElementById('logPath').value;
  if (!pathVal || !ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'fetch-logs',
    logPath: pathVal,
    isService: type === 'service'
  }));
}

// Modal and CRUD Actions
function openServerModal() {
  document.getElementById('serverModal').style.display = 'flex';
}

function closeServerModal() {
  document.getElementById('serverModal').style.display = 'none';
}

function toggleAuthFields() {
  const type = document.getElementById('hostAuthType').value;
  document.getElementById('hostPassword').style.display = type === 'password' ? 'block' : 'none';
  document.getElementById('hostPrivateKey').style.display = type === 'key' ? 'block' : 'none';
}

async function saveServer() {
  const payload = {
    name: document.getElementById('hostName').value,
    host: document.getElementById('hostIp').value,
    port: parseInt(document.getElementById('hostPort').value, 10),
    username: document.getElementById('hostUser').value,
    auth_type: document.getElementById('hostAuthType').value,
    password: document.getElementById('hostPassword').value,
    private_key: document.getElementById('hostPrivateKey').value
  };

  try {
    const res = await fetch('/api/servers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      closeServerModal();
      loadServers();
      // Clear fields
      document.getElementById('hostName').value = '';
      document.getElementById('hostIp').value = '';
      document.getElementById('hostUser').value = '';
      document.getElementById('hostPassword').value = '';
      document.getElementById('hostPrivateKey').value = '';
    } else {
      const err = await res.json();
      alert(`Failed to add server: ${err.error}`);
    }
  } catch (e) {
    alert('Server unreachable');
  }
}

async function deleteActiveServer() {
  if (!activeServerId) return;
  if (!confirm('Are you sure you want to disconnect this server?')) return;

  try {
    const res = await fetch(`/api/servers/${activeServerId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.ok) {
      activeServerId = null;
      document.getElementById('activeServerDetails').style.display = 'none';
      document.getElementById('activeServerName').innerText = 'Select a Host Server';
      document.getElementById('activeServerUptime').innerText = '';
      document.getElementById('btnDeleteServer').style.display = 'none';
      loadServers();
    }
  } catch (e) {
    alert('Server unreachable');
  }
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// Bind keyboard listeners to tab triggers for WCAG compliance
function bindTabAccessibility() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        tab.click();
      }
    });
  });
}

// Init app
checkAuth();
bindTabAccessibility();
