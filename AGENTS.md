# AGENTS.md

This file gives repository-specific guidance to coding agents working in Lunaria.

## Project Summary

Lunaria is a Live2D desktop character project that connects Live2D models to OpenClaw-compatible chat backends and TTS providers.

The repository currently contains:

- `backend/`: Python FastAPI backend for chat, SSE events, model runtime, and TTS
- `desktop/`: Electron + React frontend, currently the preferred user interface
- `frontend/`: web prototype frontend; useful for debugging, but not the primary target
- `openclaw-channel-live2d/`: OpenClaw plugin for the Live2D channel bridge
- `models/`: Live2D assets
- `config.json`: active local configuration
- `config.example.json`: safer starting point for examples and docs

## Working Norms

- Prefer minimal, targeted changes that fit the existing architecture.
- Follow existing naming and file layout patterns before introducing new abstractions.
- Treat `desktop/` as the main product surface unless the user explicitly asks for the web prototype.
- Be careful with `config.json`: it may contain machine-specific IPs, local model paths, or personal defaults.
- When you need to show a sample config, prefer `config.example.json` or clearly explain any `config.json` edits.
- Do not casually rewrite or normalize user-specific model paths under `models` or config entries.

## Setup And Run

### Backend

From the repository root:

```bash
source venv/bin/activate
export LD_LIBRARY_PATH="$(nix eval --impure --raw --expr 'let pkgs = import <nixpkgs> {}; in pkgs.lib.makeLibraryPath [ pkgs.stdenv.cc.cc pkgs.zlib ]')${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
python3 run.py
```

The backend entry point is `run.py`, which starts `backend.app.fastapi_main`.

### Desktop

Currently desktop is for windows platforms only, don't run it in linux. But you can still edit the code and run typecheck and tests in linux.

## Verification

Use the smallest verification set that honestly covers the files you changed.

Common commands:

### Backend tests

```bash
python -m unittest discover -s backend/tests
```

### Desktop runtime tests

```bash
node --test desktop/src/renderer/src/runtime/__tests__/*.test.mjs
```

### Desktop typecheck

```bash
cd desktop && npm run typecheck:web
cd desktop && npm run typecheck:node
```

If you change both backend and desktop integration points, run at least backend tests, desktop runtime tests, and the relevant desktop typecheck.

## Repository-Specific Architecture Notes

### Backend manifest drives editable UI state

- `backend/app/manifest.py` is the contract between backend config and frontend settings UI.
- If you add or change editable provider fields, update the manifest shape first.
- The renderer persists provider field values locally and hydrates them from the manifest.

### Chat providers and TTS providers are separate systems

- Chat provider overrides are sent as top-level request fields.
- TTS provider overrides should remain isolated so they do not collide with chat provider fields.
- Backend TTS entry points live in `backend/app/routes/runtime.py`, `backend/app/services/tts_service.py`, and `backend/app/tts_backends/`.
- Desktop speech request wiring lives in `desktop/src/renderer/src/app/providers/command-provider.tsx`.

### Preferred frontend flow

- The Electron app in `desktop/` is the main UI target.
- The web frontend in `frontend/` is still a prototype; avoid treating it as the default UX unless requested.

## Change Boundaries

- Do not refactor broad Live2D runtime code unless the task actually requires it.
- Avoid unrelated visual rewrites in the desktop UI; preserve the existing Lunaria theme and interaction style.
- Keep backend routes thin; business logic should usually live under `backend/app/services/`.
- For new TTS or chat integrations, prefer adding backend-specific modules under the existing registries instead of hardcoding behavior into routes.

## Configuration Notes

- The project reads `config.json` at the repository root by default.
- Environment overrides also exist in the backend config loader.
- Many local setups depend on values under:
  - `desktop.backendUrl`
  - `chat.providers`
  - `chat.tts`
  - `models`

If a change requires new configuration keys, update the backend loader, manifest exposure, and any desktop settings surface that should edit those values.

## Commit Style

The recent history uses short conventional-style messages, for example:

- `feat(tts): add openai-compatible backend`
- `fix(desktop): stabilize backend connection updates`
- `refactor(renderer): reorganize renderer into app platform domains shared`

Match that style when writing commits unless the user asks for something else.
Every time you finish a change, write a commit message that clearly states what you changed and why, following the existing style.

## When In Doubt

- Inspect the closest existing implementation before inventing a new pattern.
- Verify changes with fresh commands before claiming success.
- Surface assumptions when touching config, provider wiring, or machine-specific paths.
