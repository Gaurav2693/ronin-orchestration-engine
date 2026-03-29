// test/migrationManager.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Tests for I4: SQLite → Postgres Migration Manager
// ─────────────────────────────────────────────────────────────────────────────

import {
  MIGRATION_STATUS,
  createMigrationRecord,
  parseMigrationVersion,
  MIGRATIONS_TABLE_SQL,
  createInMemoryDb,
  createMigrationManager,
  SQLitePgConversions,
} from '../infra/migrationManager.mjs';

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function assert(cond, msg)      { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ─── Sample migrations ────────────────────────────────────────────────────────

function makeMigrations(count = 3, options = {}) {
  const failOn   = options.failOn || [];
  const noDownOn = options.noDownOn || [];

  return Array.from({ length: count }, (_, i) => {
    const version = String(i + 1).padStart(4, '0');
    const name    = `${version}_create_table_${i + 1}`;
    return {
      version,
      name,
      up: async (db) => {
        if (failOn.includes(version)) throw new Error(`Migration ${version} failed`);
        await db.run(`CREATE TABLE IF NOT EXISTS table_${i + 1} (id INTEGER PRIMARY KEY)`);
      },
      ...(noDownOn.includes(version) ? {} : {
        down: async (db) => {
          await db.run(`DROP TABLE IF EXISTS table_${i + 1}`);
        },
      }),
    };
  });
}

console.log('\n─── migrationManager.test.mjs ───────────────────────────\n');

// ─── MIGRATION_STATUS ─────────────────────────────────────────────────────────

console.log('MIGRATION_STATUS:');

await testAsync('all statuses defined', async () => {
  assert(MIGRATION_STATUS.PENDING,     'PENDING');
  assert(MIGRATION_STATUS.RUNNING,     'RUNNING');
  assert(MIGRATION_STATUS.APPLIED,     'APPLIED');
  assert(MIGRATION_STATUS.FAILED,      'FAILED');
  assert(MIGRATION_STATUS.ROLLED_BACK, 'ROLLED_BACK');
});

// ─── createMigrationRecord ────────────────────────────────────────────────────

console.log('\ncreateMigrationRecord:');

await testAsync('creates record with defaults', async () => {
  const record = createMigrationRecord();
  assertEqual(record.status, MIGRATION_STATUS.PENDING, 'default status');
  assertEqual(record.version, null, 'version null by default');
  assertEqual(record.appliedAt, null, 'appliedAt null by default');
});

await testAsync('accepts overrides', async () => {
  const record = createMigrationRecord({ version: '0001', name: '0001_init', status: MIGRATION_STATUS.APPLIED });
  assertEqual(record.version, '0001', 'version');
  assertEqual(record.status, MIGRATION_STATUS.APPLIED, 'status');
});

// ─── parseMigrationVersion ────────────────────────────────────────────────────

console.log('\nparseMigrationVersion:');

await testAsync('parses valid filename', async () => {
  const parsed = parseMigrationVersion('0001_create_users');
  assert(parsed, 'should parse');
  assertEqual(parsed.version, '0001', 'version');
  assertEqual(parsed.description, 'create_users', 'description');
  assertEqual(parsed.name, '0001_create_users', 'name');
});

await testAsync('parses filename with .mjs extension', async () => {
  const parsed = parseMigrationVersion('0002_add_sessions.mjs');
  assert(parsed, 'should parse .mjs');
  assertEqual(parsed.version, '0002', 'version');
});

await testAsync('returns null for invalid filename', async () => {
  const parsed = parseMigrationVersion('invalid_file');
  assertEqual(parsed, null, 'should return null for non-standard name');
});

await testAsync('returns null for empty string', async () => {
  assertEqual(parseMigrationVersion(''), null, 'empty → null');
});

// ─── MIGRATIONS_TABLE_SQL ─────────────────────────────────────────────────────

console.log('\nMIGRATIONS_TABLE_SQL:');

await testAsync('contains CREATE TABLE statement', async () => {
  assert(MIGRATIONS_TABLE_SQL.includes('CREATE TABLE'), 'should have CREATE TABLE');
  assert(MIGRATIONS_TABLE_SQL.includes('_ronin_migrations'), 'should reference migrations table');
  assert(MIGRATIONS_TABLE_SQL.includes('version'), 'should have version column');
});

// ─── createInMemoryDb ─────────────────────────────────────────────────────────

console.log('\ncreateInMemoryDb:');

await testAsync('initializes successfully', async () => {
  const db = createInMemoryDb();
  await db.initialize();
  assert(db.isInitialized, 'should be initialized');
});

await testAsync('getAppliedMigrations returns empty initially', async () => {
  const db = createInMemoryDb();
  const applied = await db.getAppliedMigrations();
  assertEqual(applied.length, 0, 'no migrations applied initially');
});

await testAsync('markMigrationApplied stores record', async () => {
  const db = createInMemoryDb();
  await db.markMigrationApplied('0001', '0001_init', 'abc123', 50);
  const applied = await db.getAppliedMigrations();
  assertEqual(applied.length, 1, 'one migration applied');
  assertEqual(applied[0].version, '0001', 'version');
  assertEqual(applied[0].status, MIGRATION_STATUS.APPLIED, 'status APPLIED');
});

await testAsync('markMigrationFailed stores failure', async () => {
  const db = createInMemoryDb();
  await db.markMigrationFailed('0001', '0001_init', 'something went wrong');
  const applied = await db.getAppliedMigrations();
  assertEqual(applied.length, 0, 'failed migration is not in applied list');
  // Check internal store
  const record = db._migrations.get('0001');
  assertEqual(record.status, MIGRATION_STATUS.FAILED, 'failed status');
  assert(record.error.includes('something went wrong'), 'error preserved');
});

await testAsync('markMigrationRolledBack updates status', async () => {
  const db = createInMemoryDb();
  await db.markMigrationApplied('0001', '0001_init', 'abc', 10);
  await db.markMigrationRolledBack('0001');
  const record = db._migrations.get('0001');
  assertEqual(record.status, MIGRATION_STATUS.ROLLED_BACK, 'rolled back status');
  assert(record.rolledBackAt, 'rolledBackAt should be set');
});

// ─── createMigrationManager ───────────────────────────────────────────────────

console.log('\ncreateMigrationManager:');

await testAsync('throws if no db provided', async () => {
  try {
    createMigrationManager({});
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('db'), 'error mentions db');
  }
});

await testAsync('migrate applies all pending migrations', async () => {
  const db      = createInMemoryDb();
  const mgr     = createMigrationManager({ db, migrations: makeMigrations(3), silent: true });
  const result  = await mgr.migrate();
  assertEqual(result.status, 'ok', 'status ok');
  assertEqual(result.applied.length, 3, '3 migrations applied');
  assertEqual(result.failed.length, 0, 'no failures');
});

await testAsync('migrate returns up_to_date when all applied', async () => {
  const db  = createInMemoryDb();
  const mgr = createMigrationManager({ db, migrations: makeMigrations(2), silent: true });
  await mgr.migrate();
  const result2 = await mgr.migrate();
  assertEqual(result2.status, 'up_to_date', 'second run is up_to_date');
  assertEqual(result2.applied.length, 0, 'no new migrations applied');
});

await testAsync('migrate skips already-applied migrations', async () => {
  const db  = createInMemoryDb();
  const mgr = createMigrationManager({ db, migrations: makeMigrations(3), silent: true });
  await mgr.migrate();  // applies all 3
  const pending = await mgr.getPendingMigrations();
  assertEqual(pending.length, 0, 'no pending after applying all');
});

await testAsync('migrate stops on first failure', async () => {
  const db  = createInMemoryDb();
  const mgr = createMigrationManager({
    db,
    migrations: makeMigrations(3, { failOn: ['0002'] }),
    silent:     true,
  });
  const result = await mgr.migrate();
  assertEqual(result.status, 'failed', 'status failed');
  assertEqual(result.applied.length, 1, 'only first migration applied');
  assertEqual(result.failed.length, 1, 'one failure');
  // 0003 was never attempted
  assert(!result.failed.some(f => f.version === '0003'), '0003 not in failed list');
});

await testAsync('migrate in dryRun mode does not persist', async () => {
  const db  = createInMemoryDb();
  const mgr = createMigrationManager({ db, migrations: makeMigrations(3), silent: true, dryRun: true });
  const result = await mgr.migrate();
  assertEqual(result.dryRun, true, 'dryRun flag set');
  const applied = await db.getAppliedMigrations();
  assertEqual(applied.length, 0, 'nothing persisted in dryRun');
});

await testAsync('rollback calls down() and marks rolled back', async () => {
  const db      = createInMemoryDb();
  const mgr     = createMigrationManager({ db, migrations: makeMigrations(2), silent: true });
  await mgr.migrate();
  const result  = await mgr.rollback('0002');
  assertEqual(result.status, MIGRATION_STATUS.ROLLED_BACK, 'rolled back status');
});

await testAsync('rollback throws if migration has no down()', async () => {
  const db  = createInMemoryDb();
  const mgr = createMigrationManager({
    db,
    migrations: makeMigrations(1, { noDownOn: ['0001'] }),
    silent:     true,
  });
  await mgr.migrate();
  try {
    await mgr.rollback('0001');
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('rollback') || err.message.includes('down'), 'error mentions rollback');
  }
});

await testAsync('rollback throws if version not found', async () => {
  const db  = createInMemoryDb();
  const mgr = createMigrationManager({ db, migrations: makeMigrations(1), silent: true });
  try {
    await mgr.rollback('9999');
    assert(false, 'Should have thrown');
  } catch (err) {
    assert(err.message.includes('9999') || err.message.includes('not found'), 'error mentions version');
  }
});

await testAsync('status returns all migration statuses', async () => {
  const db  = createInMemoryDb();
  const mgr = createMigrationManager({ db, migrations: makeMigrations(3), silent: true });
  await mgr.migrate();  // apply all
  const statuses = await mgr.status();
  assertEqual(statuses.length, 3, '3 migration statuses');
  assert(statuses.every(s => s.status === MIGRATION_STATUS.APPLIED), 'all applied');
});

await testAsync('status shows pending for unapplied migrations', async () => {
  const db  = createInMemoryDb();
  const mgr = createMigrationManager({ db, migrations: makeMigrations(3), silent: true });
  // Only apply first one
  await db.markMigrationApplied('0001', '0001_create_table_1', 'abc', 10);
  const statuses = await mgr.status();
  const pending  = statuses.filter(s => s.status === MIGRATION_STATUS.PENDING);
  assertEqual(pending.length, 2, '2 pending migrations');
});

await testAsync('status shows hasDown flag', async () => {
  const db  = createInMemoryDb();
  const mgr = createMigrationManager({
    db,
    migrations: makeMigrations(2, { noDownOn: ['0001'] }),
    silent: true,
  });
  const statuses = await mgr.status();
  const m1 = statuses.find(s => s.version === '0001');
  const m2 = statuses.find(s => s.version === '0002');
  assert(m1 && !m1.hasDown, '0001 has no down');
  assert(m2 &&  m2.hasDown, '0002 has down');
});

await testAsync('meta.total counts all migrations', async () => {
  const db     = createInMemoryDb();
  const mgr    = createMigrationManager({ db, migrations: makeMigrations(5), silent: true });
  const result = await mgr.migrate();
  assertEqual(result.meta.total, 5, 'meta.total');
  assertEqual(result.meta.applied, 5, 'meta.applied');
});

// ─── SQLitePgConversions ──────────────────────────────────────────────────────

console.log('\nSQLitePgConversions:');

await testAsync('boolColumn conversion has up and down', async () => {
  const conv = SQLitePgConversions.boolColumn('users', 'active');
  assert(typeof conv.up === 'function', 'has up');
  assert(typeof conv.down === 'function', 'has down');
});

await testAsync('timestampColumn conversion generates valid SQL', async () => {
  const sqlStatements = [];
  const mockDb = { async run(sql) { sqlStatements.push(sql); } };
  const conv   = SQLitePgConversions.timestampColumn('sessions', 'created_at');
  await conv.up(mockDb);
  assert(sqlStatements.some(s => s.includes('timestamptz')), 'up SQL contains timestamptz');
  sqlStatements.length = 0;
  await conv.down(mockDb);
  assert(sqlStatements.some(s => s.includes('TEXT')), 'down SQL contains TEXT');
});

await testAsync('jsonbColumn conversion generates valid SQL', async () => {
  const sqlStatements = [];
  const mockDb = { async run(sql) { sqlStatements.push(sql); } };
  const conv   = SQLitePgConversions.jsonbColumn('sessions', 'metadata');
  await conv.up(mockDb);
  assert(sqlStatements.some(s => s.includes('JSONB')), 'up SQL contains JSONB');
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n─── Results: ${passed} passed, ${failed} failed ───\n`);
process.exit(failed > 0 ? 1 : 0);
