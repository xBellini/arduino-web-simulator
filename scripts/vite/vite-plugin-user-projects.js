/**
 * What: Vite middleware plugin that exposes a small local HTTP API under `/api/user-projects`
 * for listing, reading, and writing JSON circuit/project files in the repo’s `user_projects/`
 * folder during development. Validates filenames, creates the directory on demand, and keeps
 * persistence entirely on disk so the SPA can save/load without a separate backend.
 * How-to: active only when Vite dev server runs (`npm run dev`); registered from `vite.config.js`.
 * Routes: `GET /api/user-projects` → `{ files }`; `GET/PUT /api/user-projects/<name>.json` for read/write
 * (names must match `PROJECT_NAME_PATTERN`). Files live in `<repo>/user_projects/`. Extend by adding methods
 * in the middleware block inside `configureServer` — keep JSON validation on PUT to avoid corrupt saves.
 *
 * Changelog:
 * - 09-10-2026 ? Moved from `vite-plugin-user-projects.js` (tree reorganization)
 * - 17-09-2026 — Expanded What with practical how-to notes
 * - 17-09-2026 — Changelog creation
 */
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_NAME_PATTERN = /^[\w.-]+\.json$/;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** Dev-only API for reading/writing JSON projects in /user_projects. */
export function userProjectsPlugin(rootDir) {
  const projectsDir = path.join(rootDir, 'user_projects');

  return {
    name: 'user-projects',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0];
        if (!url?.startsWith('/api/user-projects')) {
          next();
          return;
        }

        if (req.method === 'GET' && url === '/api/user-projects') {
          try {
            fs.mkdirSync(projectsDir, { recursive: true });
            const files = fs
              .readdirSync(projectsDir)
              .filter((name) => name.endsWith('.json'))
              .sort((a, b) => a.localeCompare(b));
            sendJson(res, 200, { files });
          } catch {
            sendJson(res, 500, { error: 'Could not list project files' });
          }
          return;
        }

        const match = url.match(/^\/api\/user-projects\/([^/]+)$/);
        if (!match) {
          next();
          return;
        }

        const name = decodeURIComponent(match[1]);
        if (!PROJECT_NAME_PATTERN.test(name)) {
          sendJson(res, 400, { error: 'Invalid project filename' });
          return;
        }

        const filePath = path.join(projectsDir, name);

        if (req.method === 'GET') {
          try {
            if (!fs.existsSync(filePath)) {
              sendJson(res, 404, { error: 'Project not found' });
              return;
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(fs.readFileSync(filePath, 'utf-8'));
          } catch {
            sendJson(res, 500, { error: 'Could not read project file' });
          }
          return;
        }

        if (req.method === 'PUT') {
          try {
            const body = await readBody(req);
            JSON.parse(body);
            fs.mkdirSync(projectsDir, { recursive: true });
            fs.writeFileSync(filePath, body, 'utf-8');
            sendJson(res, 200, { ok: true, name });
          } catch {
            sendJson(res, 400, { error: 'Invalid project JSON' });
          }
          return;
        }

        next();
      });
    },
  };
}
