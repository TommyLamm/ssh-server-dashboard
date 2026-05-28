const { parseCpu, parseMem, parseDisk, parseProcesses, parseDocker, pool, closeConnection, closeAll } = require('../src/sshPool');

describe('SSH Module', () => {

  describe('parseCpu', () => {
    test('extracts user+sys percentages from standard output', () => {
      const stdout = "%Cpu(s):  5.2 us,  2.1 sy,  0.0 ni, 92.7 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st";
      const res = parseCpu(stdout);
      expect(res).toBeCloseTo(7.3);
    });

    test('ignores non-CPU lines and finds the correct %Cpu(s) line', () => {
      const stdout = "Some arbitrary process name with 50.0 id in name\n%Cpu(s):  0.0 us,  0.0 sy,  0.0 ni, 90.0 id,  0.0 wa";
      const res = parseCpu(stdout);
      expect(res).toBeCloseTo(10.0);
    });

    test('returns 0 for empty string input', () => {
      expect(parseCpu('')).toBe(0.0);
    });

    test('returns 0 when no %Cpu(s) line exists', () => {
      expect(parseCpu('Some random output\nwith no cpu info')).toBe(0.0);
    });

    test('clamps result between 0 and 100', () => {
      // If idle is 0%, usage should be 100%
      const stdout = "%Cpu(s):  50.0 us,  50.0 sy,  0.0 ni,  0.0 id";
      expect(parseCpu(stdout)).toBe(100);
    });

    test('handles 100% idle correctly', () => {
      const stdout = "%Cpu(s):  0.0 us,  0.0 sy,  0.0 ni, 100.0 id";
      expect(parseCpu(stdout)).toBe(0);
    });
  });

  describe('parseMem', () => {
    test('extracts memory usage accurately', () => {
      const stdout =
`               total        used        free      shared  buff/cache   available
Mem:      8248565760  2062141440  3093212160    10485760  3093212160  5889982464
Swap:     2147483648   536870912  1610612736`;
      const res = parseMem(stdout);
      expect(res.total).toBe(8248565760);
      expect(res.used).toBe(2062141440);
      expect(res.percent).toBeCloseTo(25.0);
    });

    test('handles invalid output and returns defaults', () => {
      const stdout = 'Mem: invalid total used';
      const res = parseMem(stdout);
      expect(res).toEqual({ total: 0, used: 0, percent: 0 });
    });

    test('returns defaults for empty string', () => {
      expect(parseMem('')).toEqual({ total: 0, used: 0, percent: 0 });
    });

    test('returns defaults when no Mem: line exists', () => {
      expect(parseMem('Swap: 1000 500 500')).toEqual({ total: 0, used: 0, percent: 0 });
    });

    test('handles zero total memory', () => {
      const stdout = 'Mem: 0 0 0';
      const res = parseMem(stdout);
      expect(res.percent).toBe(0);
    });
  });

  describe('parseDisk', () => {
    test('parses block device details', () => {
      const stdout = `/dev/sda1 ext4 100G 40G 60G 40% /`;
      const res = parseDisk(stdout);
      expect(res.length).toBe(1);
      expect(res[0].device).toBe('/dev/sda1');
      expect(res[0].used_percent).toBe(40);
      expect(res[0].mount).toBe('/');
    });

    test('handles mount paths with spaces', () => {
      const stdout = `/dev/sda1 ext4 100G 40G 60G 40% /my mount path`;
      const res = parseDisk(stdout);
      expect(res.length).toBe(1);
      expect(res[0].mount).toBe('/my mount path');
    });

    test('handles NaN in used_percent and defaults to 0', () => {
      const stdout = `/dev/sda1 ext4 100G 40G 60G invalid% /`;
      const res = parseDisk(stdout);
      expect(res[0].used_percent).toBe(0);
    });

    test('returns empty array for empty input', () => {
      expect(parseDisk('')).toEqual([]);
    });

    test('skips header lines starting with "Filesystem" or "source"', () => {
      const stdout = `Filesystem Type Size Used Avail Use% Mounted on\n/dev/sda1 ext4 100G 40G 60G 40% /`;
      const res = parseDisk(stdout);
      expect(res.length).toBe(1);
      expect(res[0].device).toBe('/dev/sda1');
    });

    test('skips lines with fewer than 7 columns', () => {
      const stdout = `/dev/sda1 ext4 100G 40G`;
      const res = parseDisk(stdout);
      expect(res.length).toBe(0);
    });

    test('parses multiple disks', () => {
      const stdout = `/dev/sda1 ext4 100G 40G 60G 40% /\n/dev/sdb1 xfs 500G 200G 300G 40% /data`;
      const res = parseDisk(stdout);
      expect(res.length).toBe(2);
      expect(res[1].device).toBe('/dev/sdb1');
      expect(res[1].mount).toBe('/data');
    });
  });

  describe('parseProcesses', () => {
    test('parses process columns correctly', () => {
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

    test('handles NaN in numeric fields and defaults to 0', () => {
      const stdout =
`  PID USER     %CPU %MEM COMMAND
 invalid root      invalid  invalid nginx`;
      const res = parseProcesses(stdout);
      expect(res[0].pid).toBe(0);
      expect(res[0].cpu).toBe(0);
      expect(res[0].mem).toBe(0);
    });

    test('returns empty array for header-only input', () => {
      const stdout = `  PID USER     %CPU %MEM COMMAND`;
      const res = parseProcesses(stdout);
      expect(res.length).toBe(0);
    });

    test('returns empty array for empty input', () => {
      const stdout = '';
      const res = parseProcesses(stdout);
      expect(res.length).toBe(0);
    });

    test('handles commands with spaces', () => {
      const stdout = `  PID USER     %CPU %MEM COMMAND\n 100 root      1.0  0.5 /usr/bin/some command`;
      const res = parseProcesses(stdout);
      expect(res[0].command).toBe('/usr/bin/some command');
    });
  });

  describe('parseDocker', () => {
    test('parses line-separated Docker JSON and handles invalid JSON', () => {
      const stdout =
`{"ID":"1","Name":"web","Status":"Up"}
{"ID":"2","Name":"db","Status":"Exited"}
invalid-json-line`;
      const res = parseDocker(stdout);
      expect(res.length).toBe(2);
      expect(res[0].Name).toBe('web');
      expect(res[1].Name).toBe('db');
    });

    test('returns empty array for empty string', () => {
      expect(parseDocker('')).toEqual([]);
    });

    test('skips null JSON values', () => {
      const stdout = 'null\n{"name":"web"}';
      const res = parseDocker(stdout);
      expect(res.length).toBe(1);
      expect(res[0].name).toBe('web');
    });

    test('skips primitive JSON values', () => {
      const stdout = '42\n"string"\n{"name":"valid"}';
      const res = parseDocker(stdout);
      expect(res.length).toBe(1);
    });
  });

  describe('Connection pool management', () => {
    test('closeConnection removes connection from pool and closes it', async () => {
      const mockConn = { end: jest.fn() };
      const mockPromise = Promise.resolve(mockConn);

      pool['test-server-id'] = mockPromise;

      closeConnection('test-server-id');

      expect(pool['test-server-id']).toBeUndefined();

      await mockPromise;
      expect(mockConn.end).toHaveBeenCalled();
    });

    test('closeConnection handles non-existent pool entry gracefully', () => {
      expect(() => closeConnection('non-existent-id')).not.toThrow();
    });

    test('closeConnection handles rejected promise gracefully', async () => {
      const rejectedPromise = Promise.reject(new Error('conn failed'));
      // Prevent unhandled rejection
      rejectedPromise.catch(() => {});

      pool['failed-conn'] = rejectedPromise;
      expect(() => closeConnection('failed-conn')).not.toThrow();
      expect(pool['failed-conn']).toBeUndefined();
    });

    test('closeAll removes all connections from pool', async () => {
      const mockConn1 = { end: jest.fn() };
      const mockConn2 = { end: jest.fn() };
      pool['server-1'] = Promise.resolve(mockConn1);
      pool['server-2'] = Promise.resolve(mockConn2);

      closeAll();

      expect(pool['server-1']).toBeUndefined();
      expect(pool['server-2']).toBeUndefined();

      // Allow promises to resolve
      await new Promise(r => setTimeout(r, 10));
      expect(mockConn1.end).toHaveBeenCalled();
      expect(mockConn2.end).toHaveBeenCalled();
    });

    test('closeAll on empty pool does nothing', () => {
      // Ensure pool is empty
      Object.keys(pool).forEach(k => delete pool[k]);
      expect(() => closeAll()).not.toThrow();
    });
  });
});
