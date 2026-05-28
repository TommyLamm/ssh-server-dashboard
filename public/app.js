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

// WebSocket reconnect state
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

// Process filter state
let processFilterText = '';

// ====== Toast notifications ======
function showToast(message, type) {
  type = type || 'info';
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(function () {
    toast.classList.add('toast-dismiss');
    toast.addEventListener('animationend', function () {
      toast.remove();
    });
  }, 4000);
}

// ====== WebSocket status indicator ======
function updateWsStatus(state) {
  var el = document.getElementById('wsStatus');
  if (!el) return;
  el.className = 'ws-status ' + state;
  el.title = 'WebSocket: ' + state;
  var label = el.querySelector('.ws-status-label');
  if (label) {
    label.textContent = state.charAt(0).toUpperCase() + state.slice(1);
  }
}

// ====== Auth ======
function checkAuth() {
  if (token) {
    document.getElementById('loginPage').style.display = 'none';
    var dash = document.getElementById('dashboardApp');
    dash.style.display = 'flex';
    dash.classList.remove('dashboard-hidden');
    document.getElementById('loginUserInfo').innerText = 'Logged in as admin';
    loadServers();
    connectWebSocket();
  } else {
    document.getElementById('loginPage').style.display = 'flex';
    var dash = document.getElementById('dashboardApp');
    dash.style.display = 'none';
    dash.classList.add('dashboard-hidden');
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

  // Clear sparkline history
  cpuHistory.length = 0;
  ramHistory.length = 0;
  diskHistory.length = 0;

  checkAuth();
}

// ====== Server list (XSS-safe DOM construction) ======
async function loadServers() {
  try {
    const res = await fetch('/api/servers', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (res.status === 401) return logout();
    const servers = await res.json();
    const list = document.getElementById('serverList');
    list.innerHTML = '';
    servers.forEach(function (srv) {
      var div = document.createElement('div');
      div.className = 'server-item' + (activeServerId === srv.id ? ' active' : '');
      div.onclick = function () { selectServer(srv.id, srv.name); };

      var row = document.createElement('div');
      row.className = 'server-item-row';

      var nameEl = document.createElement('strong');
      nameEl.textContent = srv.name;

      var dot = document.createElement('span');
      dot.className = 'status-dot status-offline';
      dot.id = 'dot-' + srv.id;

      row.appendChild(nameEl);
      row.appendChild(dot);

      var hostEl = document.createElement('div');
      hostEl.className = 'server-item-host';
      hostEl.textContent = srv.host + ':' + srv.port;

      div.appendChild(row);
      div.appendChild(hostEl);
      list.appendChild(div);
    });
  } catch (err) {
    console.error('Failed to load servers:', err.message);
  }
}

// ====== WebSocket ======
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }
  updateWsStatus('reconnecting');
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(protocol + '//' + window.location.host + '/ws/monitor');

  ws.onopen = function () {
    reconnectAttempts = 0;
    updateWsStatus('connected');
    ws.send(JSON.stringify({ type: 'auth', token: token }));
  };

  ws.onmessage = function (event) {
    var data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      console.error('Failed to parse WS message:', e);
      return;
    }

    if (data.type === 'authenticated') {
      if (activeServerId) {
        requestServerMetrics(activeServerId);
      }
    }

    if (data.type === 'metrics') {
      var dot = document.getElementById('dot-' + data.serverId);
      if (dot) {
        dot.className = 'status-dot ' + (data.status === 'online' ? 'status-online' : 'status-offline');
      }

      if (data.serverId === activeServerId) {
        // Hide loading indicator once metrics arrive
        document.getElementById('loadingIndicator').style.display = 'none';

        if (data.status === 'online') {
          var details = document.getElementById('activeServerDetails');
          details.style.display = 'block';
          details.classList.remove('active-server-details-hidden');
          document.getElementById('activeServerUptime').innerText = 'Uptime: ' + data.metrics.uptime;
          updateOverviewMetrics(data.metrics);
          triggerTabFetch();
        } else {
          document.getElementById('activeServerUptime').innerText = 'Offline: ' + data.error;
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
        var logConsole = document.getElementById('logConsole');
        logConsole.innerText = data.logs;
        logConsole.scrollTop = logConsole.scrollHeight;
      }
    }
  };

  ws.onerror = function (err) {
    console.error('WebSocket error:', err);
    updateWsStatus('disconnected');
  };

  ws.onclose = function () {
    updateWsStatus('disconnected');
    var delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    updateWsStatus('reconnecting');
    setTimeout(connectWebSocket, delay);
  };
}

// ====== Server selection ======
function selectServer(id, name) {
  activeServerId = id;
  document.getElementById('activeServerName').innerText = name;
  var btnDel = document.getElementById('btnDeleteServer');
  btnDel.style.display = 'block';

  // Show loading indicator
  document.getElementById('loadingIndicator').style.display = 'flex';

  // Clear charts history
  cpuHistory.length = 0;
  ramHistory.length = 0;
  diskHistory.length = 0;

  // Clear tab panels UI
  document.getElementById('processesList').innerHTML = '';
  document.getElementById('dockerList').innerHTML = '';
  document.getElementById('logConsole').innerText = '';

  // Update active sidebar class locally (no redundant loadServers call)
  document.querySelectorAll('.server-item').forEach(function (item) {
    item.classList.remove('active');
  });
  // Find the clicked item and set active by matching the dot id
  var dot = document.getElementById('dot-' + id);
  if (dot) {
    var serverItemEl = dot.closest('.server-item');
    if (serverItemEl) serverItemEl.classList.add('active');
  }

  requestServerMetrics(id);
  switchTab(currentTab);
}

function requestServerMetrics(id) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'select-server', serverId: id }));
  }
}

// ====== Metrics (with null guards) ======
function updateOverviewMetrics(metrics) {
  // CPU usage
  var cpuVal = metrics.cpu != null ? metrics.cpu : 0;
  document.getElementById('metric-cpu-val').innerText = cpuVal.toFixed(1) + '%';
  cpuHistory.push(cpuVal);
  if (cpuHistory.length > maxHistory) cpuHistory.shift();
  drawSparkline('cpuSparkline', cpuHistory, '#06b6d4');

  // RAM memory usage
  var ramVal = metrics.mem && metrics.mem.percent != null ? metrics.mem.percent : 0;
  var usedGb = metrics.mem && metrics.mem.used != null ? (metrics.mem.used / 1024 / 1024 / 1024).toFixed(2) : '0.00';
  var totalGb = metrics.mem && metrics.mem.total != null ? (metrics.mem.total / 1024 / 1024 / 1024).toFixed(2) : '0.00';
  document.getElementById('metric-ram-val').innerText = ramVal.toFixed(1) + '%';
  document.getElementById('metric-ram-details').innerText = 'Used: ' + usedGb + ' GB / Total: ' + totalGb + ' GB';
  ramHistory.push(ramVal);
  if (ramHistory.length > maxHistory) ramHistory.shift();
  drawSparkline('ramSparkline', ramHistory, '#8b5cf6');

  // Storage usage
  if (metrics.disk && metrics.disk.length > 0) {
    var root = metrics.disk[0];
    var diskVal = root.used_percent != null ? root.used_percent : 0;
    document.getElementById('metric-disk-val').innerText = diskVal + '%';
    document.getElementById('metric-disk-details').innerText = 'Avail: ' + root.avail + ' / Total: ' + root.size + ' on ' + root.mount;
    diskHistory.push(diskVal);
    if (diskHistory.length > maxHistory) diskHistory.shift();
    drawSparkline('diskSparkline', diskHistory, '#eab308');
  }
}

function drawSparkline(canvasId, history, color) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();

  var step = canvas.width / (maxHistory - 1);
  history.forEach(function (val, index) {
    var x = index * step;
    var y = canvas.height - (val / 100) * canvas.height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ====== Tabs ======
function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.tab').forEach(function (t) {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });
  document.querySelectorAll('.tab-panel').forEach(function (p) {
    p.style.display = 'none';
    p.classList.add('tab-panel-hidden');
  });

  var tabElem = document.getElementById('tab-' + tabName);
  if (tabElem) {
    tabElem.classList.add('active');
    tabElem.setAttribute('aria-selected', 'true');
  }
  var panelElem = document.getElementById('panel-' + tabName);
  if (panelElem) {
    panelElem.style.display = 'block';
    panelElem.classList.remove('tab-panel-hidden');
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

// ====== Process sorting ======
function toggleProcessSort(field) {
  if (sortField === field) {
    sortDesc = !sortDesc;
  } else {
    sortField = field;
    sortDesc = true;
  }
  renderProcesses(currentProcesses);
}

// ====== Render processes (XSS-safe) ======
function renderProcesses(processes) {
  currentProcesses = processes;
  var body = document.getElementById('processesList');
  body.innerHTML = '';

  // Apply filter
  var filtered = processes;
  if (processFilterText) {
    var lowerFilter = processFilterText.toLowerCase();
    filtered = processes.filter(function (p) {
      return p.command && p.command.toLowerCase().indexOf(lowerFilter) !== -1;
    });
  }

  var sorted = filtered.slice().sort(function (a, b) {
    var valA = a[sortField];
    var valB = b[sortField];
    if (typeof valA === 'string') {
      return sortDesc ? valB.localeCompare(valA) : valA.localeCompare(valB);
    }
    return sortDesc ? valB - valA : valA - valB;
  });

  sorted.forEach(function (p) {
    var tr = document.createElement('tr');
    tr.className = 'table-row';

    var tdPid = document.createElement('td');
    tdPid.className = 'table-cell';
    tdPid.textContent = p.pid;

    var tdUser = document.createElement('td');
    tdUser.textContent = p.user;

    var tdCpu = document.createElement('td');
    tdCpu.className = 'table-cell-cyan';
    tdCpu.textContent = p.cpu.toFixed(1) + '%';

    var tdMem = document.createElement('td');
    tdMem.textContent = p.mem.toFixed(1) + '%';

    var tdCmd = document.createElement('td');
    tdCmd.className = 'table-cell-mono';
    tdCmd.textContent = p.command;

    tr.appendChild(tdPid);
    tr.appendChild(tdUser);
    tr.appendChild(tdCpu);
    tr.appendChild(tdMem);
    tr.appendChild(tdCmd);
    body.appendChild(tr);
  });
}

// ====== Render Docker (XSS-safe) ======
function renderDocker(containers, error) {
  var body = document.getElementById('dockerList');
  body.innerHTML = '';
  if (error) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.setAttribute('colspan', '3');
    td.className = 'table-error';
    td.textContent = error;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  containers.forEach(function (c) {
    var tr = document.createElement('tr');
    tr.className = 'table-row';

    var tdName = document.createElement('td');
    tdName.className = 'table-cell';
    var strong = document.createElement('strong');
    strong.textContent = c.name;
    tdName.appendChild(strong);

    var tdCpu = document.createElement('td');
    tdCpu.className = 'table-cell-cyan';
    tdCpu.textContent = c.cpu;

    var tdMem = document.createElement('td');
    tdMem.textContent = c.mem;

    tr.appendChild(tdName);
    tr.appendChild(tdCpu);
    tr.appendChild(tdMem);
    body.appendChild(tr);
  });
}

// ====== Logs ======
function updateLogPlaceholder() {
  var type = document.getElementById('logSourceType').value;
  var input = document.getElementById('logPath');
  if (type === 'service') {
    input.placeholder = 'e.g. nginx';
  } else {
    input.placeholder = 'e.g. /var/log/syslog';
  }
}

function fetchLogs() {
  var type = document.getElementById('logSourceType').value;
  var pathVal = document.getElementById('logPath').value;
  if (!pathVal || !ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({
    type: 'fetch-logs',
    logPath: pathVal,
    isService: type === 'service'
  }));
}

// ====== Modal and CRUD ======
function openServerModal() {
  var modal = document.getElementById('serverModal');
  modal.style.display = 'flex';
  modal.classList.remove('modal-hidden');
}

function closeServerModal() {
  var modal = document.getElementById('serverModal');
  modal.style.display = 'none';
  modal.classList.add('modal-hidden');
}

function toggleAuthFields() {
  var type = document.getElementById('hostAuthType').value;
  document.getElementById('hostPassword').style.display = type === 'password' ? 'block' : 'none';
  document.getElementById('hostPrivateKey').style.display = type === 'key' ? 'block' : 'none';
}

async function saveServer() {
  var payload = {
    name: document.getElementById('hostName').value,
    host: document.getElementById('hostIp').value,
    port: parseInt(document.getElementById('hostPort').value, 10),
    username: document.getElementById('hostUser').value,
    auth_type: document.getElementById('hostAuthType').value,
    password: document.getElementById('hostPassword').value,
    private_key: document.getElementById('hostPrivateKey').value
  };

  try {
    var res = await fetch('/api/servers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      closeServerModal();
      loadServers();
      // Clear fields
      document.getElementById('hostName').value = '';
      document.getElementById('hostIp').value = '';
      document.getElementById('hostPort').value = '22';
      document.getElementById('hostUser').value = '';
      document.getElementById('hostPassword').value = '';
      document.getElementById('hostPrivateKey').value = '';
      showToast('Server added successfully', 'success');
    } else {
      var err = await res.json();
      showToast('Failed to add server: ' + (err.error || 'Unknown error'), 'error');
    }
  } catch (e) {
    showToast('Server unreachable', 'error');
  }
}

async function deleteActiveServer() {
  if (!activeServerId) return;
  if (!confirm('Are you sure you want to disconnect this server?')) return;

  try {
    var res = await fetch('/api/servers/' + activeServerId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + token }
    });

    if (res.ok) {
      activeServerId = null;
      var details = document.getElementById('activeServerDetails');
      details.style.display = 'none';
      details.classList.add('active-server-details-hidden');
      document.getElementById('activeServerName').innerText = 'Select a Host Server';
      document.getElementById('activeServerUptime').innerText = '';
      document.getElementById('btnDeleteServer').style.display = 'none';
      loadServers();
      showToast('Server removed', 'info');
    }
  } catch (e) {
    showToast('Server unreachable', 'error');
  }
}

// ====== Sidebar ======
function toggleSidebar() {
  var sidebar = document.getElementById('sidebar');
  var backdrop = document.getElementById('sidebarBackdrop');
  sidebar.classList.toggle('open');
  if (sidebar.classList.contains('open')) {
    backdrop.classList.add('visible');
  } else {
    backdrop.classList.remove('visible');
  }
}

// ====== Accessibility ======
function bindTabAccessibility() {
  var tabs = document.querySelectorAll('.tab');
  tabs.forEach(function (tab) {
    tab.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        tab.click();
      }

      // Arrow key navigation between tabs
      var tabsArr = Array.from(document.querySelectorAll('.tab'));
      var index = tabsArr.indexOf(tab);
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        var next = tabsArr[(index + 1) % tabsArr.length];
        next.focus();
        next.click();
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        var prev = tabsArr[(index - 1 + tabsArr.length) % tabsArr.length];
        prev.focus();
        prev.click();
      }
    });
  });
}

// ====== Escape key to close modal ======
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    var modal = document.getElementById('serverModal');
    if (modal && modal.style.display !== 'none' && !modal.classList.contains('modal-hidden')) {
      closeServerModal();
    }
  }
});

// ====== Backdrop click to close modal ======
document.addEventListener('click', function (e) {
  var modal = document.getElementById('serverModal');
  if (e.target === modal) {
    closeServerModal();
  }
});

// ====== Process filter input ======
document.addEventListener('DOMContentLoaded', function () {
  var filterInput = document.getElementById('processFilter');
  if (filterInput) {
    filterInput.addEventListener('input', function () {
      processFilterText = filterInput.value;
      renderProcesses(currentProcesses);
    });
  }
});

// ====== Init app ======
checkAuth();
bindTabAccessibility();
