import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiHandler } from './app.js';
import { createAgentRuntime } from './agent-runtime.js';
import { createStore } from './store.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 4174);
const production = process.env.NODE_ENV === 'production';
const dbPath = process.env.THREADLINE_DB_PATH || join(root, '.threadline', 'threadline.db');
const store = createStore(dbPath, { seed: process.env.THREADLINE_EMPTY !== '1' });
const interruptedRuns = store.recoverInterruptedRuns();
const agentRuntime = createAgentRuntime(store, { stateRoot: dirname(dbPath) });
const handleApi = createApiHandler(store, { agentRuntime });
let vite;

if (!production) {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({
    root,
    server: { middlewareMode: true, ws: { port: port + 1, clientPort: port + 1 } },
    appType: 'spa'
  });
}

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const server = createServer(async (request, response) => {
  if (await handleApi(request, response)) return;
  if (vite) {
    vite.middlewares(request, response, () => {
      response.writeHead(404);
      response.end('Not found');
    });
    return;
  }

  const distRoot = join(root, 'dist');
  const pathname = decodeURIComponent(new URL(request.url, 'http://threadline.local').pathname);
  const requested = pathname === '/' ? '/index.html' : pathname;
  let file = resolve(distRoot, `.${requested}`);
  if (file !== distRoot && !file.startsWith(`${distRoot}${sep}`)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  if (!existsSync(file)) file = join(distRoot, 'index.html');
  response.writeHead(200, { 'content-type': contentTypes[extname(file)] || 'application/octet-stream' });
  response.end(readFileSync(file));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Threadline running at http://127.0.0.1:${port}`);
  console.log(`State: ${dbPath}`);
  console.log(`Agent adapter: ${agentRuntime.adapterInfo().name}${agentRuntime.adapterInfo().available ? '' : ' (unavailable)'}`);
  if (interruptedRuns) console.log(`Recovered ${interruptedRuns} interrupted agent run${interruptedRuns === 1 ? '' : 's'}.`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await vite?.close();
  agentRuntime.shutdown();
  store.close();
  server.close();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
