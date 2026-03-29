// infra/migrationManager.mjs
// ─────────────────────────────────────────────────────────────────────────────
// I4: SQLite → Postgres Migration Manager
//
// Manages database schema migrations and data migration from SQLite (dev/local)
// to Postgres (production). Supports incremental migrations with a version
// table, rollback support, and dry-run mode.
//
// Migration lifecycle:
//   pending → running → applied | failed
//
// Migration files follow the naming convention:
//   NNNN_description.mjs  (e.g. 0001_create_sessions.mjs)
//
// Each migration exports:
//   up(db)   → apply migration
//   down(db) → rollback migration (optional)
//
// Usage:
//   const mgr = createMigrationManager({ db: postgresClient });
//   const result = await mgr.migrate();
//   // → { applied[], skipped[], failed[], status }
// ─────────────────────────────────────────────────────────────────────────────

// ─── Migration Status ─────────────────────────────────────────────────────────

export const MIGRATION_STATUS = {
  PENDING:  'pending',
  RUNNING:  'running',
  APPLIED:  'applied',
  FAILED:   'failed',
  ROLLED_BACK: 'rolled_back',
};

// ─── Migration record ─────────────────────────────────────────────────────────

export function createMigrationRecord(overrides = {}) {
  return {
    version:     null,      // e.g. '0001'
    name:        null,      // e.g. '0001_create_sessions'
    status:      MIGRATION_STATUS.PENDING,
    appliedAt:   null,
    rolledBackAt: null,
    error:       null,
    durationMs:  null,
    checksum:    null,
    ...overrides,
  };
}

// ─── Parse migration version from filename ────────────────────────────────────

export function parseMigrationVersion(filename) {
  const match = filename.match(/^(\d{4})_(.+?)(?:\.mjs)?$/);
  if (!match) return null;
  return { version: match[1], description: match[2], name: `${match[1]}_${match[2]}` };
}

// ─── Schema SQL for the migrations table ─────────────────────────────────────

export const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS _ronin_migrations (
  id           SERIAL PRIMARY KEY,
  version      VARCHAR(10) NOT NULL UNIQUE,
  name         VARCHAR(255) NOT NULL,
  status       VARCHAR(20)  NOT NULL DEFAULT 'pending',
  checksum     VARCHAR(64),
  applied_at   TIMESTAMPTZ,
  duration_ms  INTEGER,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`.trim();

// ─── Simple checksum (no crypto module needed) ────────────────────────────────

function _simpleChecksum(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

// ─── In-memory DB adapter (for testing without real DB) ───────────────────────

export function createInMemoryDb() {
  const migrations = new Map();   // version → record
  let _initialized = false;

  return {
    async initialize() {
      _initialized = true;
    },

    async getAppliedMigrations() {
      return [...migrations.values()].filter(m => m.status === MIGRATION_STATUS.APPLIED);
    },

    async markMigrationApplied(version, name, checksum, durationMs) {
      migrations.set(version, createMigrationRecord({
        version, name, checksum, durationMs,
        status:    MIGRATION_STATUS.APPLIED,
        appliedAt: new Date().toISOString(),
      }));
    },

    async markMigrationFailed(version, name, error) {
      migrations.set(version, createMigrationRecord({
        version, name, error,
        status: MIGRATION_STATUS.FAILED,
      }));
    },

    async markMigrationRolledBack(version) {
      const existing = migrations.get(version);
      if (existing) {
        existing.status       = MIGRATION_STATUS.ROLLED_BACK;
        existing.rolledBackAt = new Date().toISOString();
      }
    },

    async run(sql, params = []) {
      // No-op for in-memory — real adapter runs SQL
      return { rowCount: 0, rows: [] };
    },

    get isInitialized() { return _initialized; },
    _migrations: migrations,  // exposed for testing
  };
}

// ─── Migration manager factory ────────────────────────────────────────────────

export function createMigrationManager(options = {}) {
  const {
    db,            // database adapter (must implement getAppliedMigrations, markMigrationApplied, etc.)
    migrations = [], // [{ version, name, up, down }] or loaded from files
    silent     = false,
    dryRun     = false,
  } = options;

  if (!db) throw new Error('[migrationManager] db adapter is required');

  function _log(...args) {
    if (!silent) console.log('[MigrationManager]', ...args);
  }

  // ─── Initialize migrations table ─────────────────────────────────────
  async function initialize() {
    if (typeof db.initialize === 'function') {
      await db.initialize();
    } else if (typeof db.run === 'function') {
      await db.run(MIGRATIONS_TABLE_SQL);
    }
    _log('migrations table ready');
  }

  // ─── Get pending migrations ───────────────────────────────────────────
  async function getPendingMigrations() {
    const applied      = await db.getAppliedMigrations();
    const appliedSet   = new Set(applied.map(m => m.version));

    return migrations
      .filter(m => !appliedSet.has(m.version))
      .sort((a, b) => a.version.localeCompare(b.version));
  }

  // ─── Apply a single migration ─────────────────────────────────────────
  async function _applyMigration(migration) {
    const start    = Date.now();
    const checksum = _simpleChecksum(migration.up.toString());

    _log(`applying migration ${migration.version}: ${migration.name}${dryRun ? ' [DRY RUN]' : ''}`);

    if (dryRun) {
      return createMigrationRecord({
        version: migration.version,
        name:    migration.name,
        status:  MIGRATION_STATUS.APPLIED,
        checksum,
        durationMs: 0,
        appliedAt: new Date().toISOString(),
      });
    }

    try {
      await migration.up(db);
      const durationMs = Date.now() - start;
      await db.markMigrationApplied(migration.version, migration.name, checksum, durationMs);

      _log(`✓ ${migration.version} applied in ${durationMs}ms`);
      return createMigrationRecord({
        version: migration.version,
        name:    migration.name,
        status:  MIGRATION_STATUS.APPLIED,
        checksum,
        durationMs,
        appliedAt: new Date().toISOString(),
      });
    } catch (err) {
      await db.markMigrationFailed(migration.version, migration.name, err.message);
      _log(`✗ ${migration.version} failed: ${err.message}`);
      throw err;
    }
  }

  // ─── Rollback a migration ─────────────────────────────────────────────
  async function rollback(version) {
    const migration = migrations.find(m => m.version === version);
    if (!migration) throw new Error(`Migration ${version} not found`);
    if (!migration.down) throw new Error(`Migration ${version} has no rollback (down) function`);

    _log(`rolling back migration ${version}${dryRun ? ' [DRY RUN]' : ''}`);

    if (dryRun) {
      return { version, status: MIGRATION_STATUS.ROLLED_BACK, dryRun: true };
    }

    await migration.down(db);
    await db.markMigrationRolledBack(version);
    _log(`↩ ${version} rolled back`);

    return { version, status: MIGRATION_STATUS.ROLLED_BACK };
  }

  // ─── Main: migrate (run all pending) ─────────────────────────────────
  async function migrate() {
    await initialize();

    const pending  = await getPendingMigrations();
    const applied  = [];
    const skipped  = [];
    const failed   = [];

    _log(`${pending.length} pending migration${pending.length !== 1 ? 's' : ''}`);

    for (const migration of pending) {
      try {
        const result = await _applyMigration(migration);
        applied.push(result);
      } catch (err) {
        failed.push(createMigrationRecord({
          version: migration.version,
          name:    migration.name,
          status:  MIGRATION_STATUS.FAILED,
          error:   err.message,
        }));
        // Stop on first failure
        break;
      }
    }

    const status = failed.length > 0 ? 'failed' : applied.length > 0 ? 'ok' : 'up_to_date';

    return {
      status,
      applied,
      skipped,
      failed,
      dryRun,
      meta: {
        total:    migrations.length,
        pending:  pending.length,
        applied:  applied.length,
        failed:   failed.length,
      },
    };
  }

  // ─── Status: see what's been applied ─────────────────────────────────
  async function status() {
    await initialize();

    const appliedMigrations = await db.getAppliedMigrations();
    const appliedVersions   = new Set(appliedMigrations.map(m => m.version));

    return migrations.map(m => ({
      version:  m.version,
      name:     m.name,
      status:   appliedVersions.has(m.version) ? MIGRATION_STATUS.APPLIED : MIGRATION_STATUS.PENDING,
      hasDown:  typeof m.down === 'function',
    }));
  }

  return { migrate, rollback, status, getPendingMigrations, initialize };
}

// ─── SQLite → Postgres data migration helper ──────────────────────────────────
// Provides utilities for common data type conversions.

export const SQLitePgConversions = {
  // SQLite INTEGER (0/1) → Postgres BOOLEAN
  boolColumn: (tableName, colName) => ({
    version: null,
    up: async (db) => {
      await db.run(`ALTER TABLE ${tableName} ALTER COLUMN ${colName} TYPE BOOLEAN USING ${colName}::boolean`);
    },
    down: async (db) => {
      await db.run(`ALTER TABLE ${tableName} ALTER COLUMN ${colName} TYPE INTEGER USING ${colName}::int`);
    },
  }),

  // SQLite TEXT (ISO string) → Postgres TIMESTAMPTZ
  timestampColumn: (tableName, colName) => ({
    version: null,
    up: async (db) => {
      await db.run(`ALTER TABLE ${tableName} ALTER COLUMN ${colName} TYPE TIMESTAMPTZ USING ${colName}::timestamptz`);
    },
    down: async (db) => {
      await db.run(`ALTER TABLE ${tableName} ALTER COLUMN ${colName} TYPE TEXT USING ${colName}::text`);
    },
  }),

  // SQLite TEXT (JSON) → Postgres JSONB
  jsonbColumn: (tableName, colName) => ({
    version: null,
    up: async (db) => {
      await db.run(`ALTER TABLE ${tableName} ALTER COLUMN ${colName} TYPE JSONB USING ${colName}::jsonb`);
    },
    down: async (db) => {
      await db.run(`ALTER TABLE ${tableName} ALTER COLUMN ${colName} TYPE TEXT USING ${colName}::text`);
    },
  }),
};
