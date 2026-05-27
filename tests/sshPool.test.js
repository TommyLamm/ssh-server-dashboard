const { parseCpu, parseMem, parseDisk, parseProcesses, parseDocker } = require('../src/sshPool');

describe('SSH Command Output Parsers', () => {
  test('parseCpu extracts user+sys percentages', () => {
    const stdout = "%Cpu(s):  5.2 us,  2.1 sy,  0.0 ni, 92.7 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st";
    const res = parseCpu(stdout);
    expect(res).toBeCloseTo(7.3);
  });

  test('parseMem extracts memory usage accurately', () => {
    const stdout = 
`               total        used        free      shared  buff/cache   available
Mem:      8248565760  2062141440  3093212160    10485760  3093212160  5889982464
Swap:     2147483648   536870912  1610612736`;
    const res = parseMem(stdout);
    expect(res.total).toBe(8248565760);
    expect(res.used).toBe(2062141440);
    expect(res.percent).toBeCloseTo(25.0);
  });

  test('parseMem handles invalid output and returns defaults', () => {
    const stdout = 'Mem: invalid total used';
    const res = parseMem(stdout);
    expect(res).toEqual({ total: 0, used: 0, percent: 0 });
  });

  test('parseDisk parses block devices details', () => {
    const stdout = `/dev/sda1 ext4 100G 40G 60G 40% /`;
    const res = parseDisk(stdout);
    expect(res.length).toBe(1);
    expect(res[0].device).toBe('/dev/sda1');
    expect(res[0].used_percent).toBe(40);
    expect(res[0].mount).toBe('/');
  });

  test('parseDisk handles mount paths with spaces', () => {
    const stdout = `/dev/sda1 ext4 100G 40G 60G 40% /my mount path`;
    const res = parseDisk(stdout);
    expect(res.length).toBe(1);
    expect(res[0].mount).toBe('/my mount path');
  });

  test('parseProcesses parses processes columns', () => {
    const stdout = 
`  PID USER     %CPU %MEM COMMAND
 1204 root      2.4  0.5 nginx
 1421 systemd   0.0  1.2 systemd-journal`;
    const res = parseProcesses(stdout);
    expect(res.length).toBe(2);
    expect(res[0].pid).toBe(1204);
    expect(res[0].cpu).toBe(2.4);
    expect(res[0].command).toBe('nginx');
  });

  test('parseDocker parses line-separated Docker JSON and handles invalid JSON', () => {
    const stdout = 
`{"ID":"1","Name":"web","Status":"Up"}
{"ID":"2","Name":"db","Status":"Exited"}
invalid-json-line`;
    const res = parseDocker(stdout);
    expect(res.length).toBe(2);
    expect(res[0].Name).toBe('web');
    expect(res[1].Name).toBe('db');
  });
});
