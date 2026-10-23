import { expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';

test('preload isolates destructive tests from an inherited live data directory', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'claude-mem-preload-isolation-'));
  try {
    const fakeLive = join(sandbox, 'fake-live');
    const home = join(sandbox, 'home');
    const config = join(sandbox, 'config');
    for (const dir of [fakeLive, home, config]) mkdirSync(dir);
    const database = join(fakeLive, 'claude-mem.db');
    const settings = join(fakeLive, 'settings.json');
    const databaseSentinel = 'live database sentinel';
    const settingsSentinel = '{"live":"settings sentinel"}';
    writeFileSync(database, databaseSentinel);
    writeFileSync(settings, settingsSentinel);

    const preload = fileURLToPath(new URL('./preload.ts', import.meta.url));
    const appPaths = new URL('../src/shared/paths.ts', import.meta.url).href;
    const resultPath = join(sandbox, 'resolved-paths.json');
    const fixture = join(sandbox, 'destructive.test.ts');
    writeFileSync(fixture, `
      import { test } from 'bun:test';
      import { rmSync, writeFileSync } from 'fs';
      import { DATA_DIR, DB_PATH, USER_SETTINGS_PATH, resolveDbPath, paths } from ${JSON.stringify(appPaths)};
      test('exercise the actual application paths after preload', () => {
        for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
        writeFileSync(DB_PATH, 'test database');
        writeFileSync(USER_SETTINGS_PATH, '{"test":true}');
        writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
          dataDir: DATA_DIR, database: DB_PATH, settings: USER_SETTINGS_PATH,
          dynamicDatabase: resolveDbPath(), pathDatabase: paths.database(),
          pathSettings: paths.settings(),
        }));
      });
    `);

    const child = spawnSync(process.execPath, ['test', '--preload', preload, fixture], {
      cwd: sandbox,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: sandbox,
        TMP: sandbox,
        TEMP: sandbox,
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_MEM_DATA_DIR: fakeLive,
        CLAUDE_MEM_WORKER_PORT: '0',
        CLAUDE_MEM_WORKER_AUTOSTART: 'false',
      },
      encoding: 'utf-8',
      timeout: 20_000,
    });
    expect(child.error).toBeUndefined();
    expect({ status: child.status, stderr: child.stderr }).toEqual({
      status: 0,
      stderr: expect.any(String),
    });
    expect(readFileSync(database, 'utf-8')).toBe(databaseSentinel);
    expect(readFileSync(settings, 'utf-8')).toBe(settingsSentinel);

    const resolved = JSON.parse(readFileSync(resultPath, 'utf-8'));
    expect(resolved.dataDir).not.toBe(fakeLive);
    expect(resolved.dataDir.startsWith(join(sandbox, 'claude-mem-test-run-'))).toBe(true);
    for (const path of [resolved.database, resolved.dynamicDatabase, resolved.pathDatabase]) {
      expect(path).toBe(join(resolved.dataDir, 'claude-mem.db'));
    }
    expect(resolved.settings).toBe(join(resolved.dataDir, 'settings.json'));
    expect(resolved.pathSettings).toBe(resolved.settings);
    expect(readFileSync(resolved.database, 'utf-8')).toBe('test database');
    expect(readFileSync(resolved.settings, 'utf-8')).toBe('{"test":true}');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}, 30_000);
