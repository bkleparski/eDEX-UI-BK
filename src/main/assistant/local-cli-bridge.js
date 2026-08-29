'use strict';

const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { PROVIDER_IDS } = require('./contracts');

const MAX_BODY_BYTES = 128 * 1024;

function sanitizeTerminalText(value) {
  return String(value ?? '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b(?:[@-_][0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}

function secureTokenMatches(header, token) {
  const supplied = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Prompt is too large.'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

class LocalCliBridge {
  // `platform` is a constructor override for unit tests only — production
  // callers always take the process.platform default. Windows has no AF_UNIX
  // support worth relying on from Node's http server, so it gets a loopback
  // TCP port instead of the socket file every other platform uses.
  constructor({ userDataPath, assistantService, configStore, fsImpl = fs, platform = process.platform } = {}) {
    if (!path.isAbsolute(userDataPath || '') || !assistantService || !configStore) {
      throw new TypeError('LocalCliBridge requires userDataPath, assistantService and configStore.');
    }
    this.fs = fsImpl;
    this.assistantService = assistantService;
    this.configStore = configStore;
    this.platform = platform;
    this.directory = path.join(userDataPath, 'run');
    this.socketPath = path.join(this.directory, 'assistant.sock');
    this.port = null;
    this.token = randomBytes(32).toString('hex');
    this.server = null;
    this.controllers = new Set();
  }

  environment(binPath) {
    if (!this.server?.listening) return {};
    const base = {
      EDEX_AI_TOKEN: this.token,
      PATH: `${binPath}${path.delimiter}${process.env.PATH || (this.platform === 'win32' ? '' : '/usr/bin:/bin')}`
    };
    return this.platform === 'win32'
      ? { ...base, EDEX_AI_PORT: String(this.port) }
      : { ...base, EDEX_AI_SOCKET: this.socketPath };
  }

  prepareSocket() {
    if (this.platform === 'win32') return;
    this.fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    try {
      const stat = this.fs.lstatSync(this.socketPath);
      if (!stat.isSocket()) throw new Error('CLI bridge path exists and is not a socket.');
      this.fs.unlinkSync(this.socketPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  start() {
    if (this.server?.listening) return Promise.resolve(this.platform === 'win32' ? this.port : this.socketPath);
    this.prepareSocket();
    this.server = http.createServer((request, response) => this.handle(request, response));
    return new Promise((resolve, reject) => {
      const fail = (error) => reject(error);
      this.server.once('error', fail);
      if (this.platform === 'win32') {
        // 127.0.0.1 only, never 0.0.0.0 — this must not be reachable from the
        // LAN. Port 0 asks the OS for any free ephemeral port.
        this.server.listen(0, '127.0.0.1', () => {
          this.server.removeListener('error', fail);
          this.port = this.server.address().port;
          resolve(this.port);
        });
        return;
      }
      this.server.listen(this.socketPath, () => {
        this.server.removeListener('error', fail);
        this.fs.chmodSync(this.socketPath, 0o600);
        resolve(this.socketPath);
      });
    });
  }

  async handle(request, response) {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (!secureTokenMatches(request.headers.authorization, this.token)) {
      response.writeHead(401).end('CLI bridge authorization failed.\n');
      return;
    }
    if (request.method !== 'POST' || !['/ai', '/search'].includes(request.url)) {
      response.writeHead(404).end('Unknown CLI command.\n');
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    let finished = false;
    response.on('close', () => {
      if (!finished) controller.abort();
    });
    try {
      const prompt = (await readRequestBody(request)).trim();
      if (!prompt) {
        response.writeHead(400).end('Prompt is required.\n');
        return;
      }
      const provider = request.headers['x-edex-provider'] === 'lmstudio'
        ? PROVIDER_IDS.LM_STUDIO
        : PROVIDER_IDS.OLLAMA;
      const config = this.configStore.get();
      const model = config.selection.models[provider];
      if (!model) {
        response.writeHead(409).end(`No active model selected for ${provider}.\n`);
        return;
      }
      response.writeHead(200);
      let wroteText = false;
      const sources = new Map();
      await this.assistantService.run({
        requestId: `cli-${randomUUID()}`,
        prompt,
        provider,
        model,
        mode: request.url === '/search' ? 'search' : 'chat',
        surface: 'terminal'
      }, {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'text-delta' && event.text) {
            wroteText = true;
            response.write(sanitizeTerminalText(event.text));
          }
          for (const source of event.sources || []) {
            if (source?.url) sources.set(source.url, source.title || source.url);
          }
        }
      });
      if (!wroteText) response.write('No response content.');
      if (sources.size) {
        response.write('\n\nSOURCES\n');
        for (const [url, title] of sources) response.write(`${sanitizeTerminalText(title)}\n${sanitizeTerminalText(url)}\n`);
      }
      response.end('\n');
    } catch (error) {
      const status = error?.statusCode || (error?.code === 'ABORTED' ? 499 : 500);
      const message = sanitizeTerminalText(error?.message || 'Assistant request failed.');
      if (!response.headersSent) response.writeHead(status);
      response.end(`ERROR / ${error?.code || 'ASSISTANT_ERROR'} / ${message}\n`);
    } finally {
      finished = true;
      this.controllers.delete(controller);
    }
  }

  async stop() {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
    this.port = null;
    if (this.platform === 'win32') return;
    try {
      const stat = this.fs.lstatSync(this.socketPath);
      if (stat.isSocket()) this.fs.unlinkSync(this.socketPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

module.exports = { LocalCliBridge, MAX_BODY_BYTES, sanitizeTerminalText, secureTokenMatches };
