// ─── forge/forgeToolRegistry.mjs ──────────────────────────────────────────────
// RONIN Forge Engine — Phase 11B (B1)
//
// Forge Tool Registry: 7 tools that agents can use in the sandbox.
// Every tool has security baked in:
// - Read blocklist (env, secrets, keys)
// - Protected file list (core intelligence + api modules)
// - Command blocklist (destructive, privilege escalation)
// - Network restrictions (no internal IPs, localhost)
//
// Tools are sandboxed and timeout-enforced. All tool invocations are tracked.
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import https from 'https';
import http from 'http';

const execAsync = promisify(exec);

// ─── Security Configuration ────────────────────────────────────────────────────

const PROTECTED_FILES = new Set([
  'intelligence/',
  'intelligence/operatorProfile.mjs',
  'intelligence/voiceSchema.mjs',
  'intelligence/taskMode.mjs',
  'intelligence/renderer.mjs',
  'intelligence/topologyLearner.mjs',
  'intelligence/epistemicGuard.mjs',
  'intelligence/critic.mjs',
  'intelligence/insightEngine.mjs',
  'intelligence/memoryManager.mjs',
  'execution/runTask.mjs',
  'api/sseController.mjs',
  'api/chatServer.mjs',
  'config/modelConfig.mjs',
]);

const BLOCKLIST_READ = [
  /\.env($|\..*)/,
  /\.pem$/,
  /\.key$/,
  /secrets\./,
  /\.secret$/,
];

const BLOCKLIST_COMMANDS = [
  /rm\s+-rf\s+\//,
  /docker/i,
  /sudo/,
  /chmod\s+777/,
  /curl.*\|\s*sh/i,
];

// ─── Tool Registry Factory ────────────────────────────────────────────────────

export function createForgeToolRegistry(sandboxPath = process.cwd()) {
  const tools = new Map();
  const toolStats = {
    read_file: { calls: 0, bytes: 0, errors: 0 },
    write_file: { calls: 0, bytes: 0, errors: 0 },
    list_directory: { calls: 0, items: 0, errors: 0 },
    bash: { calls: 0, exitCodes: {}, errors: 0 },
    run_tests: { calls: 0, passed: 0, failed: 0, errors: 0 },
    search_code: { calls: 0, matches: 0, errors: 0 },
    web_fetch: { calls: 0, statusCodes: {}, errors: 0 },
  };

  // ─── Tool: read_file ────────────────────────────────────────────────────────

  function toolReadFile(args) {
    toolStats.read_file.calls++;
    try {
      const { path: filePath } = args;
      if (!filePath) throw new Error('path is required');

      // Check blocklist
      for (const pattern of BLOCKLIST_READ) {
        if (pattern.test(filePath)) {
          return {
            blocked: true,
            reason: 'sensitive',
            message: `File "${filePath}" is in the read blocklist. (env, secrets, keys)`,
          };
        }
      }

      // Verify path is within sandbox
      const resolved = path.resolve(sandboxPath, filePath);
      if (!resolved.startsWith(path.resolve(sandboxPath))) {
        return {
          blocked: true,
          reason: 'path_escape',
          message: 'Path escapes sandbox boundary',
        };
      }

      // Read file
      const content = fs.readFileSync(resolved, 'utf8');
      toolStats.read_file.bytes += content.length;
      return { ok: true, content, bytesRead: content.length };
    } catch (err) {
      toolStats.read_file.errors++;
      return { ok: false, error: err.message };
    }
  }

  // ─── Tool: write_file ───────────────────────────────────────────────────────

  function toolWriteFile(args) {
    toolStats.write_file.calls++;
    try {
      const { path: filePath, content } = args;
      if (!filePath || content === undefined) {
        throw new Error('path and content are required');
      }

      // Check protected files
      let isProtected = false;
      for (const protPath of PROTECTED_FILES) {
        if (filePath.includes(protPath)) {
          isProtected = true;
          break;
        }
      }

      if (isProtected) {
        return {
          blocked: true,
          reason: 'protected',
          message: `File "${filePath}" is protected. Requires approval.`,
          requiresApproval: true,
        };
      }

      // Verify path is within sandbox
      const resolved = path.resolve(sandboxPath, filePath);
      if (!resolved.startsWith(path.resolve(sandboxPath))) {
        return {
          blocked: true,
          reason: 'path_escape',
          message: 'Path escapes sandbox boundary',
        };
      }

      // Ensure directory exists
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write file
      fs.writeFileSync(resolved, content, 'utf8');
      toolStats.write_file.bytes += content.length;
      return {
        ok: true,
        bytesWritten: content.length,
        path: filePath,
      };
    } catch (err) {
      toolStats.write_file.errors++;
      return { ok: false, error: err.message };
    }
  }

  // ─── Tool: list_directory ───────────────────────────────────────────────────

  function toolListDirectory(args) {
    toolStats.list_directory.calls++;
    try {
      const { path: dirPath, maxDepth = 4 } = args;

      // Verify path is within sandbox
      const resolved = path.resolve(sandboxPath, dirPath || '.');
      if (!resolved.startsWith(path.resolve(sandboxPath))) {
        return {
          ok: false,
          error: 'Path escapes sandbox boundary',
        };
      }

      function buildTree(dir, depth = 0) {
        if (depth > maxDepth) return null;

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const items = entries
          .filter(e => !e.name.startsWith('.'))
          .map(e => {
            toolStats.list_directory.items++;
            const fullPath = path.join(dir, e.name);
            const relPath = path.relative(sandboxPath, fullPath);
            if (e.isDirectory()) {
              return {
                type: 'dir',
                name: e.name,
                path: relPath,
                children: buildTree(fullPath, depth + 1),
              };
            } else {
              const stat = fs.statSync(fullPath);
              return {
                type: 'file',
                name: e.name,
                path: relPath,
                size: stat.size,
              };
            }
          });
        return items;
      }

      const tree = buildTree(resolved);
      return { ok: true, tree };
    } catch (err) {
      toolStats.list_directory.errors++;
      return { ok: false, error: err.message };
    }
  }

  // ─── Tool: bash ─────────────────────────────────────────────────────────────

  function toolBash(args) {
    toolStats.bash.calls++;
    try {
      const { command } = args;
      if (!command) throw new Error('command is required');

      // Check blocklist
      for (const pattern of BLOCKLIST_COMMANDS) {
        if (pattern.test(command)) {
          return {
            blocked: true,
            reason: 'dangerous',
            message: `Command is blocked for safety: ${command}`,
          };
        }
      }

      // Execute with timeout (30 seconds)
      let stdout = '';
      let stderr = '';
      let exitCode = 0;

      try {
        stdout = execSync(command, {
          cwd: sandboxPath,
          timeout: 30000,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf8',
        });
      } catch (err) {
        stdout = err.stdout || '';
        stderr = err.stderr || err.message;
        exitCode = err.status || 1;
      }

      toolStats.bash.exitCodes[exitCode] =
        (toolStats.bash.exitCodes[exitCode] || 0) + 1;

      return {
        ok: true,
        stdout,
        stderr,
        exitCode,
        command,
      };
    } catch (err) {
      toolStats.bash.errors++;
      return { ok: false, error: err.message };
    }
  }

  // ─── Tool: run_tests ────────────────────────────────────────────────────────

  function toolRunTests(args) {
    toolStats.run_tests.calls++;
    try {
      const { pattern } = args;
      let cmd = 'npm test';
      if (pattern) {
        cmd += ` -- --testPathPattern="${pattern.replace(/"/g, '\\"')}"`;
      }

      let stdout = '';
      let stderr = '';
      let passed = 0;
      let failed = 0;

      try {
        stdout = execSync(cmd, {
          cwd: sandboxPath,
          timeout: 120000,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf8',
          env: { ...process.env, NODE_ENV: 'test' },
        });
      } catch (err) {
        stdout = err.stdout || '';
        stderr = err.stderr || err.message;
      }

      // Parse test output (Jest format)
      const passMatch = stdout.match(/(\d+)\s+passed/);
      const failMatch = stdout.match(/(\d+)\s+failed/);
      passed = passMatch ? parseInt(passMatch[1], 10) : 0;
      failed = failMatch ? parseInt(failMatch[1], 10) : 0;

      toolStats.run_tests.passed += passed;
      toolStats.run_tests.failed += failed;

      return {
        ok: true,
        passed,
        failed,
        total: passed + failed,
        output: stdout.slice(-2000), // Last 2000 chars
        pattern: pattern || 'all',
      };
    } catch (err) {
      toolStats.run_tests.errors++;
      return { ok: false, error: err.message };
    }
  }

  // ─── Tool: search_code ──────────────────────────────────────────────────────

  function toolSearchCode(args) {
    toolStats.search_code.calls++;
    try {
      const { pattern, glob = '**/*.{js,mjs,ts}' } = args;
      if (!pattern) throw new Error('pattern is required');

      const matches = [];
      const maxResults = 50;

      function walkDir(dir) {
        if (matches.length >= maxResults) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (matches.length >= maxResults) break;
          const fullPath = path.join(dir, entry.name);
          const relPath = path.relative(sandboxPath, fullPath);

          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.')) {
              walkDir(fullPath);
            }
          } else {
            // Simple glob check
            if (relPath.match(/\.(js|mjs|ts)$/)) {
              try {
                const content = fs.readFileSync(fullPath, 'utf8');
                const lines = content.split('\n');
                const regex = new RegExp(pattern, 'gi');
                lines.forEach((line, idx) => {
                  const match = line.match(regex);
                  if (match) {
                    matches.push({
                      file: relPath,
                      line: idx + 1,
                      match: line.trim().slice(0, 100),
                      count: match.length,
                    });
                    toolStats.search_code.matches += match.length;
                  }
                });
              } catch (err) {
                // Skip unreadable files
              }
            }
          }
        }
      }

      walkDir(sandboxPath);
      return { ok: true, matches: matches.slice(0, maxResults), total: matches.length };
    } catch (err) {
      toolStats.search_code.errors++;
      return { ok: false, error: err.message };
    }
  }

  // ─── Tool: web_fetch ────────────────────────────────────────────────────────

  function toolWebFetch(args) {
    toolStats.web_fetch.calls++;
    return new Promise((resolve) => {
      try {
        const { url } = args;
        if (!url) throw new Error('url is required');

        // Security checks
        const urlObj = new URL(url);
        if (
          urlObj.hostname === 'localhost' ||
          urlObj.hostname === '127.0.0.1' ||
          urlObj.hostname.startsWith('192.168.') ||
          urlObj.hostname.startsWith('10.')
        ) {
          return resolve({
            blocked: true,
            reason: 'internal_ip',
            message: 'Cannot fetch from internal IPs or localhost',
          });
        }

        const protocol = urlObj.protocol === 'https:' ? https : http;
        const timeout = 10000;

        protocol
          .get(
            url,
            {
              timeout,
              headers: { 'User-Agent': 'RONIN-Forge/1.0' },
            },
            (res) => {
              let data = '';
              toolStats.web_fetch.statusCodes[res.statusCode] =
                (toolStats.web_fetch.statusCodes[res.statusCode] || 0) + 1;

              res.on('data', (chunk) => {
                data += chunk;
              });

              res.on('end', () => {
                resolve({
                  ok: true,
                  status: res.statusCode,
                  body: data.slice(0, 50000), // Max 50KB
                  headers: res.headers,
                  url,
                });
              });
            }
          )
          .on('error', (err) => {
            toolStats.web_fetch.errors++;
            resolve({ ok: false, error: err.message });
          })
          .on('timeout', () => {
            toolStats.web_fetch.errors++;
            resolve({ ok: false, error: 'Request timeout (10s)' });
          });
      } catch (err) {
        toolStats.web_fetch.errors++;
        resolve({ ok: false, error: err.message });
      }
    });
  }

  // ─── Registry Interface ──────────────────────────────────────────────────────

  function register(name, handler, schema = {}) {
    tools.set(name, { handler, schema, name });
  }

  function getTool(name) {
    const tool = tools.get(name);
    if (!tool) {
      throw new Error(
        `[forgeToolRegistry] Unknown tool: "${name}". Available: ${[...tools.keys()].join(', ')}`
      );
    }
    return tool;
  }

  function listTools() {
    return [...tools.entries()].map(([name, t]) => ({
      name,
      schema: t.schema,
    }));
  }

  function getToolSchemas() {
    return listTools().map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...t.schema,
      },
    }));
  }

  async function executeTool(name, args) {
    const tool = getTool(name);
    const result = await Promise.resolve(tool.handler(args));
    return result;
  }

  function getStats() {
    return { ...toolStats };
  }

  function getSandboxPath() {
    return sandboxPath;
  }

  // ─── Register All Tools ──────────────────────────────────────────────────────

  register('read_file', toolReadFile, {
    description: 'Read file from sandbox. Blocked: .env, *.pem, *.key, secrets.*',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to file' },
      },
      required: ['path'],
    },
  });

  register('write_file', toolWriteFile, {
    description: 'Write file to sandbox. Protected files require approval.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to file' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
    },
  });

  register('list_directory', toolListDirectory, {
    description: 'List files in directory. Max depth: 4.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path (default: root)' },
        maxDepth: { type: 'number', description: 'Max recursion depth (1-4)' },
      },
    },
  });

  register('bash', toolBash, {
    description: 'Execute shell command. Timeout: 30s. Blocked: destructive commands.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
  });

  register('run_tests', toolRunTests, {
    description: 'Run tests with npm test. Max 2 minutes.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Optional Jest testPathPattern regex',
        },
      },
    },
  });

  register('search_code', toolSearchCode, {
    description: 'Search code files for regex pattern. Max 50 results.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search' },
        glob: { type: 'string', description: 'File glob pattern' },
      },
      required: ['pattern'],
    },
  });

  register('web_fetch', toolWebFetch, {
    description: 'Fetch HTTP URL. Max 50KB. Timeout: 10s. Blocked: internal IPs.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch' },
      },
      required: ['url'],
    },
  });

  // ─── Return Registry Interface ───────────────────────────────────────────────

  return {
    register,
    getTool,
    listTools,
    getToolSchemas,
    executeTool,
    getStats,
    getSandboxPath,
  };
}

// ─── Export ────────────────────────────────────────────────────────────────────

export default createForgeToolRegistry;
