# PiDP-11 Hacker Replicant

An AI tutor/copilot that sits next to Oscar Vermeulen's PiDP-11 replica: a
web page with the real operator console on the left, and a chat panel on
the right that knows 2.11BSD (plus RT-11, RSX-11M+, RSTS/E, and Unix v1-v7)
— and, if you let it, can type into the console itself.

This is the first "Hacker Replicant" packaged for the community. It's part
of a small family built for different PDP/VAX/HP replicas; this one is
PiDP-11-specific, but the pattern (a chat panel + a tiny `screen`-reading
boot-API + an LLM backend) is reusable for other machines too.

![screenshot placeholder](docs/screenshot.png)

## How it works

```
Browser
 │
 ├─ Left panel:  <iframe> → your existing web console (ttyd or similar)
 │
 └─ Right panel: chat → POST /api/chat (SSE stream)
      │  this Node service (server.js)
      │
      ├─ LLM backend: any OpenAI-compatible /chat/completions API
      │  (local Ollama by default, or a hosted provider -- see below)
      │
      └─ when the control toggle is ON, two tools only:
           send_keys   → POST  <BOOTAPI_BASE>/keys    {"text": "..."}
           read_screen → GET   <BOOTAPI_BASE>/screen
           (served by pidp11-bootapi.py, included in this repo)
```

There's no SIMH API involved. The machine's console runs inside a GNU
`screen` session (the same one your web terminal already attaches to).
`pidp11-bootapi.py` is a ~100-line stdlib-only Python HTTP server that
exposes exactly two actions on that session:

- `screen -X stuff <text>` — types text into the session, as if someone sat
  down and typed it.
- `screen -X hardcopy <file>` — writes a plain-text snapshot of the current
  screen contents to a file, which the API reads back.

That's the entire "control" surface: no shell access, no filesystem access,
nothing beyond what's visible in the same terminal you can already see.

## LLM-agnostic by design

The chat backend talks to **any backend that speaks the OpenAI-compatible
`/chat/completions` API with tool/function calling** — that's one code
path for both:

- **Local** (default, free): point it at a local [Ollama](https://ollama.com)
  install. Ollama has spoken this API since mid-2024, nothing extra to
  configure beyond pulling a model that supports tool calling (`qwen3`,
  `llama3.1`+, `mistral-nemo`, etc. all do).
- **Cloud** (optional, for a faster/smarter option): point it at OpenAI,
  Groq, Together, Fireworks, DeepSeek, Mistral, OpenRouter, a hosted
  vLLM/TGI endpoint — anything OpenAI-compatible. See `.env.example` for
  examples.

No vendor SDK, no hard dependency on any single provider, no API key
required at all if you only use the local backend.

## Setup

### Prerequisites

- A PiDP-11 (or any PDP-11 replica/emulator) running SIMH inside a `screen`
  session, with a web console (ttyd or similar) already attached to that
  session. If you can already open a browser tab and see/use the console,
  you have what this needs.
- Node.js 18+ and Python 3 on the host running the console.
- [Ollama](https://ollama.com) running somewhere reachable (for the free
  local backend), or an API key for a cloud provider.

### Install

```bash
git clone <this-repo-url>
cd pidp11-hacker-replicant
npm install
cp .env.example .env
# edit .env: at minimum set CONSOLE_URL and BOOTAPI_BASE to match your setup
```

### Run the boot-API (on the machine with the `screen` session)

```bash
python3 pidp11-bootapi.py
```

Edit the `SESSION` constant at the top of `pidp11-bootapi.py` if your
`screen` session isn't named `pidp11`.

### Run the chat backend

```bash
npm start
```

Open `http://<host>:8100/` (or whatever `PORT` you set).

### Running both as services

See `docs/pidp11-bootapi.service.example` and
`docs/pidp11-hacker-replicant.service.example` for ready-to-adapt systemd
units.

## Configuration reference

All configuration is environment variables — see `.env.example` for the
full list with examples. The short version:

| Variable | What |
|---|---|
| `PORT` | Port the chat backend listens on |
| `CONSOLE_URL` | Your existing web console, shown in the left panel |
| `BOOTAPI_BASE` | Where `pidp11-bootapi.py` is reachable |
| `ACTION_LIMIT` | Tool calls per turn before the agent must ask to continue |
| `LOCAL_BASE_URL` / `LOCAL_API_KEY` / `LOCAL_MODEL` | Local (default) backend |
| `CLOUD_BASE_URL` / `CLOUD_API_KEY` / `CLOUD_MODEL` | Optional cloud backend |

## Safety model

- The control toggle is **off** on every page load — by default the agent
  only talks, it never touches the machine.
- When on, the agent gets exactly two tools (`send_keys`, `read_screen`),
  nothing else — no shell, no filesystem, no network access beyond the
  boot-API.
- After `ACTION_LIMIT` tool calls in one turn, the agent is cut off from
  further tool calls and must ask in plain text whether it may continue —
  no silent, unbounded action streak. A hard iteration cap (20) sits
  underneath as a defensive backstop against a broken loop.
- Everything the agent types is visible live in the same terminal session
  your own web console shows — no black box.
- This does **not** protect you from the agent typing something wrong (it's
  an LLM, it can make mistakes) — the boundary is on *what* it can touch,
  not on *how well* it types. Use a local/free backend if you want to
  experiment without any cost risk.

## Adapting this for a different replica

`pidp11-bootapi.py` is deliberately small and machine-specific only in its
`SESSION` name and `status()` heuristic — it's a reasonable starting point
for wiring up the same pattern on a different PDP/VAX/HP/whatever replica:
same two primitives (`screen -X stuff` / `screen -X hardcopy`), same tiny
HTTP wrapper. `skills/bsd-tutor.md` is the only file that's actually
PDP-11/2.11BSD-specific content; swap it for a system prompt about your own
machine and point `server.js` at the new file.

## Credits

Built by Rolf Peters with Seb (his homelab AI assistant), in collaboration
with Oscar Vermeulen (designer of the PiDP replica series). Inspired by
Oscar's own `agent-pdp1` project for the PiDP-1.

## License

MIT — see `LICENSE`.
