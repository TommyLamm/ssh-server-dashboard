// public/app.js

let activeServerId = null;

function renderProcesses(processes) {
  // Front-end rendering stub
}

function renderDocker(containers, error) {
  // Front-end rendering stub
}

function handleSocketMessage(event) {
  const data = JSON.parse(event.data);

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
      const logConsole = document.getElementById('logConsole');
      if (logConsole) {
        logConsole.innerText = data.logs;
      }
    }
  }
}
