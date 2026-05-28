function parseCpu(stdout) {
  if (stdout.includes('%Cpu(s):')) {
    const lines = stdout.split('\n');
    const cpuLine = lines.find(l => l.trim().startsWith('%Cpu(s):'));
    if (cpuLine) {
      const match = cpuLine.match(/([\d.]+)\s*%?\s*id/);
      if (match) {
        const idle = parseFloat(match[1]);
        if (isNaN(idle)) return 0.0;
        return Math.max(0, Math.min(100, 100 - idle));
      }
    }
    return 0.0;
  }

  if (/^cpu\s+\d/m.test(stdout)) {
    const lines = stdout.split('\n');
    const cpuStats = {};
    
    lines.forEach(line => {
      const trimmed = line.trim();
      if (trimmed.startsWith('cpu')) {
        const parts = trimmed.split(/\s+/);
        const name = parts[0];
        const values = parts.slice(1).map(Number);
        if (!cpuStats[name]) {
          cpuStats[name] = [];
        }
        cpuStats[name].push(values);
      }
    });

    const results = {
      overall: 0.0,
      cores: []
    };

    const coreNames = Object.keys(cpuStats).filter(name => name !== 'cpu').sort((a, b) => {
      const numA = parseInt(a.replace('cpu', ''), 10);
      const numB = parseInt(b.replace('cpu', ''), 10);
      return numA - numB;
    });

    if (cpuStats['cpu'] && cpuStats['cpu'].length >= 2) {
      const v1 = cpuStats['cpu'][0];
      const v2 = cpuStats['cpu'][1];
      const total1 = v1.reduce((a, b) => a + b, 0);
      const total2 = v2.reduce((a, b) => a + b, 0);
      const diffTotal = total2 - total1;
      const idle1 = v1[3] + (v1[4] || 0);
      const idle2 = v2[3] + (v2[4] || 0);
      const diffIdle = idle2 - idle1;
      if (diffTotal > 0) {
        results.overall = Math.max(0, Math.min(100, 100 * (1 - diffIdle / diffTotal)));
      }
    }

    coreNames.forEach(name => {
      if (cpuStats[name] && cpuStats[name].length >= 2) {
        const v1 = cpuStats[name][0];
        const v2 = cpuStats[name][1];
        const total1 = v1.reduce((a, b) => a + b, 0);
        const total2 = v2.reduce((a, b) => a + b, 0);
        const diffTotal = total2 - total1;
        const idle1 = v1[3] + (v1[4] || 0);
        const idle2 = v2[3] + (v2[4] || 0);
        const diffIdle = idle2 - idle1;
        if (diffTotal > 0) {
          results.cores.push(Math.max(0, Math.min(100, 100 * (1 - diffIdle / diffTotal))));
        } else {
          results.cores.push(0.0);
        }
      }
    });

    return results;
  }

  return 0.0;
}

function parseMem(stdout) {
  const lines = stdout.split('\n');
  const memLine = lines.find(l => l.trim().startsWith('Mem:'));
  if (memLine) {
    const cols = memLine.replace(/\s+/g, ' ').trim().split(' ');
    const total = parseInt(cols[1], 10);
    const used = parseInt(cols[2], 10);
    const percent = total > 0 ? (used / total) * 100 : 0;
    if (isNaN(total) || isNaN(used) || isNaN(percent)) {
      return { total: 0, used: 0, percent: 0 };
    }
    return { total, used, percent };
  }
  return { total: 0, used: 0, percent: 0 };
}

function parseDisk(stdout) {
  const lines = stdout.trim().split('\n');
  const disks = [];
  lines.forEach(line => {
    if (!line || line.trim().startsWith('source') || line.trim().startsWith('Filesystem')) return;
    const cols = line.replace(/\s+/g, ' ').trim().split(' ');
    if (cols.length >= 7) {
      let used_percent = parseInt(cols[5].replace('%', ''), 10);
      if (isNaN(used_percent)) {
        used_percent = 0;
      }
      disks.push({
        device: cols[0],
        fstype: cols[1],
        size: cols[2],
        used: cols[3],
        avail: cols[4],
        used_percent,
        mount: cols.slice(6).join(' ')
      });
    }
  });
  return disks;
}

function parseProcesses(stdout) {
  const lines = stdout.trim().split('\n');
  const processes = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.replace(/\s+/g, ' ').split(' ');
    if (cols.length >= 5) {
      let pid = parseInt(cols[0], 10);
      let cpu = parseFloat(cols[2]);
      let mem = parseFloat(cols[3]);
      if (isNaN(pid)) pid = 0;
      if (isNaN(cpu)) cpu = 0.0;
      if (isNaN(mem)) mem = 0.0;
      processes.push({
        pid,
        user: cols[1],
        cpu,
        mem,
        command: cols.slice(4).join(' ')
      });
    }
  }
  return processes;
}

function parseDocker(stdout) {
  const lines = stdout.trim().split('\n');
  const containers = [];
  lines.forEach(line => {
    if (!line) return;
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object') {
        containers.push(parsed);
      }
    } catch (e) {
      // Skip invalid JSON
    }
  });
  return containers;
}

module.exports = {
  parseCpu,
  parseMem,
  parseDisk,
  parseProcesses,
  parseDocker
};
