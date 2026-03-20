# Lunaria

[中文文档](./README.zh-CN.md)

Lunaria is a Live2D-based desktop character project designed to connect OpenClaw through Live2D models. It currently includes a Python backend, a Web prototype frontend, and an Electron desktop frontend.

The project is still under active development, but it already provides a working baseline for model loading, chat, SSE events, motion / expression directives, and TTS integration.

![window](./docs/screenshots/window.png)
![pet](./docs/screenshots/pet.png)

### Overview

- Live2D model loading and rendering
- Streaming chat output
- Expression / motion directives
- SSE event flow
- OpenClaw Channel integration
- TTS support:
  - `edge-tts`
  - `gpt-sovits`
- Web prototype frontend
- Electron desktop frontend

### Project Status

- The backend is functional and handles model runtime, chat, SSE, and TTS
- The Web frontend is an early prototype and is not recommended as the main interface
- The Electron frontend is currently the preferred way to use the project
- OpenClaw Channel support is already available
- Configuration and frontend behavior are still evolving

### Requirements

- Python 3.11+
- Node.js 18+
- npm
- OpenClaw

If you use Nix, you can also use the repository's [shell.nix](./shell.nix).

### Install Dependencies

#### Option 1: Python + npm

Install backend dependencies from the repository root:

```bash
pip install -r requirements.txt
```

Then install the Electron frontend dependencies:

```bash
cd desktop
npm install
cd ..
```

#### Option 2: Nix

```bash
nix-shell
```

This provides the Python runtime currently used by the backend in this repository.

### Configuration

The project reads `config.json` from the repository root by default.

If you want to start from the example configuration:

```bash
cp config.example.json config.json
```

In most cases, you will want to adjust:

- `server.host`
- `server.port`
- `desktop.backendUrl`
- `chat.providers`
- `chat.tts`
- `models`

### Run the Backend

Backend entry point:

```bash
python3 run.py
```

Default address:

```text
http://127.0.0.1:18080
```

### Web Frontend

The repository includes a Web frontend. Once the backend is running, you can usually access it in the browser.

That said, the Web frontend is currently best treated as a prototype:

- it is still experimental
- it still has a number of known issues
- it is useful for debugging and validation
- it is not recommended as the main interface at this stage

### Electron Frontend

The Electron frontend is currently the recommended way to use Lunaria.

Install dependencies:

```bash
cd desktop
npm install
```

Run in development mode:

```bash
npm run dev
```

If you want to build and preview locally:

```bash
npm run build
npm start
```

Notes:

- the Electron frontend still connects to the backend
- in most cases, the backend should be started first
- the default backend URL comes from `desktop.backendUrl` in `config.json`

### OpenClaw Channel

Lunaria currently supports OpenClaw Channel.

Install and enable the plugin in OpenClaw:

```bash
openclaw plugins install Lunaria/openclaw-channel-live2d
openclaw plugins enable live2d
openclaw gateway restart
```

Then configure the corresponding provider in `config.json`, for example:

```json
{
  "chat": {
    "defaultProviderId": "live2d-channel",
    "providers": [
      {
        "id": "live2d-channel",
        "type": "openclaw-channel",
        "name": "OpenClaw Channel",
        "bridgeUrl": "ws://127.0.0.1:18081",
        "agent": "main",
        "session": "live2d:direct:desktop-user"
      }
    ]
  }
}
```

### TTS

The project currently supports:

- `edge-tts`
- `gpt-sovits`

Related settings live under `chat.tts` in `config.json`.

#### edge-tts

This is the easiest option to get running first.

#### gpt-sovits

If you already have a GPT-SoVITS service available, you can integrate it by configuring `baseUrl`, `model`, `voice`, and related fields.

### Repository Layout

- `backend/`: Python backend
- `frontend/`: Web frontend
- `desktop/`: Electron frontend
- `models/`: Live2D model assets
- `openclaw-channel-live2d/`: OpenClaw Channel plugin
- `config.json`: main configuration file
- `run.py`: backend entry point
