/*
 * PiDP-11 Hacker Replicant — chat-backend
 *
 * AI-tutor/copilot naast Oscar Vermeulen's PiDP-11 replica: a web page with
 * the real operator console on the left, and a chat panel on the right that
 * knows 2.11BSD (and the other OSes the machine can run) — and, if you let
 * it, can operate the machine itself.
 *
 * LLM-agnostic by design: the chat panel can talk to ANY backend that
 * speaks the OpenAI-compatible `/chat/completions` API with tool/function
 * calling. That covers Ollama (local, free, the default), and basically
 * every hosted provider (OpenAI, Groq, Together, Fireworks, DeepSeek,
 * Mistral, local llama.cpp/vLLM/LM Studio servers, etc.) for a faster
 * "cloud" option. Configure both via environment variables — see
 * .env.example and README.md. No vendor SDK, no hard dependency on any one
 * provider.
 *
 * Two independent toggles, both controlled by the client on every request:
 *
 *   toolsEnabled (the control toggle, OFF by default on every page load)
 *     false -> plain knowledge chat. No tools, the agent can't touch the
 *              machine at all.
 *     true  -> the agent gets two tools: send_keys / read_screen, talking
 *              to the small boot-API running on the machine's host (see
 *              pidp11-bootapi.py — reuse it as-is, or use it as a template
 *              for a different replica). After ACTION_LIMIT tool calls in
 *              one turn, the loop stops and the agent has to ask in plain
 *              text whether it may continue — no silent, unbounded action
 *              streak.
 *
 *   backend ('local' | 'cloud', default 'local')
 *     Picks which entry in BACKENDS (below) to use. Both entries are just
 *     {baseUrl, apiKey, model} — same code path for either, no special-
 *     casing per provider.
 *
 * No server-side session storage: the client sends the full message
 * history with every request (same choice as the rest of the Hacker
 * Replicant family).
 */
import 'dotenv/config'; // loads .env for plain `node server.js` runs; a real
// EnvironmentFile= (systemd) or exported shell vars work fine too and simply
// take precedence over whatever .env sets, since dotenv never overwrites an
// already-set process.env value.
import express from 'express';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 8100;
const BOOTAPI_BASE = process.env.BOOTAPI_BASE || 'http://localhost:8093/api/pidp11';
const CONSOLE_URL = process.env.CONSOLE_URL || 'http://localhost:8080';
const DEFAULT_ACTION_LIMIT = Number(process.env.ACTION_LIMIT) || 5;
const HARD_CAP = 20; // defensive upper bound, independent of the user-facing limit — catches a broken loop
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 180000;

// Both backends speak the same OpenAI-compatible `/chat/completions` shape.
// 'local' defaults to a stock Ollama install (which has spoken this API
// since mid-2024); 'cloud' is unset by default — point it at whatever
// OpenAI-compatible provider you want for a faster/smarter option. Leaving
// CLOUD_BASE_URL empty just means the 'cloud' backend errors with a clear
// message instead of silently falling back — better than a confusing
// failure deep in a tool call.
const BACKENDS = {
  local: {
    baseUrl: stripTrailingSlash(process.env.LOCAL_BASE_URL || 'http://localhost:11434/v1'),
    apiKey: process.env.LOCAL_API_KEY || '',
    model: process.env.LOCAL_MODEL || 'qwen3:14b',
  },
  cloud: {
    baseUrl: stripTrailingSlash(process.env.CLOUD_BASE_URL || ''),
    apiKey: process.env.CLOUD_API_KEY || '',
    model: process.env.CLOUD_MODEL || '',
  },
};

function stripTrailingSlash(s) {
  return s.replace(/\/+$/, '');
}

const SKILL = readFileSync(join(__dirname, 'skills', 'bsd-tutor.md'), 'utf8');

// Standard OpenAI function-calling tool definitions — this exact shape is
// what every OpenAI-compatible provider (and Ollama) expects.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'send_keys',
      description:
        "Send text/keystrokes to the PiDP-11's visible operator console " +
        '(the same screen session the user sees in the left panel). ' +
        "Use '\\r' for Enter. Only call this after briefly telling the user " +
        'in chat what you are about to do.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The exact text/keystrokes to send.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_screen',
      description:
        'Read back the current contents of the PiDP-11 terminal (a hardcopy ' +
        'of the screen session). Use this to check what the machine actually ' +
        'returned instead of guessing.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

async function execTool(name, args) {
  try {
    if (name === 'send_keys') {
      const r = await fetch(`${BOOTAPI_BASE}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: args.text || '' }),
        signal: AbortSignal.timeout(10000),
      });
      return JSON.stringify(await r.json());
    }
    if (name === 'read_screen') {
      const r = await fetch(`${BOOTAPI_BASE}/screen`, { signal: AbortSignal.timeout(10000) });
      return JSON.stringify(await r.json());
    }
    return JSON.stringify({ error: `unknown tool: ${name}` });
  } catch (e) {
    return JSON.stringify({ error: 'boot-API unreachable: ' + e.message });
  }
}

async function osNote() {
  try {
    const r = await fetch(`${BOOTAPI_BASE}/status`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    if (!d.running) return '\n\n[Machine status: the emulator is not currently running.]';
    return `\n\n[Machine status: currently running: ${d.os || 'unknown'}.]`;
  } catch {
    return '\n\n[Machine status: unknown — the machine or its boot-API is unreachable.]';
  }
}

// Single call function for BOTH backends — 'local' and 'cloud' are just
// different {baseUrl, apiKey, model}, same request/response shape. This is
// the whole point of standardizing on the OpenAI-compatible API: one code
// path, swap providers via environment variables, nothing to maintain per
// vendor.
async function callLLM(backendKey, messages, tools, modelOverride) {
  const cfg = BACKENDS[backendKey] || BACKENDS.local;
  if (!cfg.baseUrl) {
    throw new Error(
      `Backend '${backendKey}' is not configured — set ${backendKey.toUpperCase()}_BASE_URL ` +
        `(and optionally _API_KEY / _MODEL) in .env. See README.md.`
    );
  }
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: modelOverride || cfg.model,
      messages,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`${backendKey}-backend HTTP ${res.status} — ${bodyText.slice(0, 500)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) {
    throw new Error(`${backendKey}-backend: unexpected response shape — ${JSON.stringify(data).slice(0, 300)}`);
  }
  return msg; // { role: 'assistant', content, tool_calls?: [{id, type, function: {name, arguments: '<json-string>'}}] }
}

const app = express();
app.use(express.json());

// index.html has one placeholder (__CONSOLE_URL__) for the iframe/back-link
// pointing at the machine's own web console — substituted here so the page
// works out of the box once CONSOLE_URL is set, no client-side config call
// needed. Everything else in public/ is served as-is.
app.get('/', (req, res) => {
  const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8').replaceAll(
    '__CONSOLE_URL__',
    CONSOLE_URL
  );
  res.set('Cache-Control', 'no-store').type('html').send(html);
});
app.use(express.static(join(__dirname, 'public'), { setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

app.post('/api/chat', async (req, res) => {
  const { messages, toolsEnabled, model, actionLimit, backend } = req.body;
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages (array) is required' });
  }
  const backendKey = backend === 'cloud' ? 'cloud' : 'local';
  const limit = Number.isInteger(actionLimit) && actionLimit > 0 ? actionLimit : DEFAULT_ACTION_LIMIT;

  // SSE instead of one blocking JSON response: a tool-using turn can take
  // anywhere from a few seconds (fast cloud model) to a couple of minutes
  // (a local model thinking out loud). Without intermediate events the UI
  // would look broken for anything but the fastest answers.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const skillWithStatus = SKILL + (await osNote());
    const systemNote = toolsEnabled
      ? `${skillWithStatus}\n\n---\nThe control toggle is ON. You have send_keys/read_screen. ` +
        `Action limit this turn: ${limit} tool calls, after which you must ask in plain text ` +
        `whether you may continue — no more tool calls until the user confirms.`
      : `${skillWithStatus}\n\n---\nThe control toggle is OFF. You have no tools — chat only.`;

    const convo = [{ role: 'system', content: systemNote }, ...messages];
    const tools = toolsEnabled ? TOOLS : undefined;
    const actionLog = [];
    let actionCount = 0;
    let hitLimit = false;

    for (let i = 0; i < HARD_CAP; i++) {
      send({ type: 'status', text: i === 0 ? 'thinking...' : 'processing the result...' });
      const useTools = hitLimit ? undefined : tools;
      const msg = await callLLM(backendKey, convo, useTools, model);
      convo.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

      if (!msg.tool_calls || !msg.tool_calls.length) {
        send({ type: 'done', response: msg.content || '(no answer)', actionLog, limitReached: hitLimit });
        return res.end();
      }

      // There are tool calls, but the limit was already hit this turn: ignore
      // them, force a plain-text question instead of acting further.
      if (hitLimit) {
        convo.push({
          role: 'system',
          content:
            'STOP. You have no tools left this turn, not even as text/pseudo-JSON. ' +
            'Write only a short, natural question now: summarize what you already did ' +
            'and ask whether you may continue with the rest. No function names, no JSON, ' +
            'no code block.',
        });
        continue;
      }

      for (const call of msg.tool_calls) {
        const name = call.function?.name;
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }
        send({ type: 'action', name, args }); // visible immediately, not just at the end
        actionCount++;
        const result = await execTool(name, args);
        actionLog.push({ name, args, result });
        convo.push({ role: 'tool', tool_call_id: call.id, content: result });
        if (actionCount >= limit) {
          hitLimit = true;
          break;
        }
      }
    }
    send({
      type: 'done',
      response: '(action/iteration limit reached without a final answer — try again)',
      actionLog,
      limitReached: true,
    });
    return res.end();
  } catch (e) {
    send({ type: 'error', message: `${req.body?.backend || 'local'}-backend error: ` + e.message });
    return res.end();
  }
});

app.listen(PORT, () => console.log(`PiDP-11 Hacker Replicant chat-backend on :${PORT}`));
