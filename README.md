# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, and fx. If they're set up on your computer, T3 Code can control them.

## What's Changed in This Fork

This fork extends T3 Code with a **Multi-Agent Team & Group Chat Collaboration System**, per-agent **`AGENTS.md` & `SKILL.md` customization**, and **Antigravity runtime improvements**:

### 1. Specialized Agent Profiles (`AgentProfile`)

- **Custom Identity & Role**: Create specialized agents with their own name, role/title, color-coded monogram badge, responsibilities, and system instructions.
- **Per-Agent Model & Effort Selection**: Assign each agent its own provider, model, **Effort / Thinking Level** (`Low`, `Medium`, `High`), runtime permission mode (`full-access`, `auto`, `auto-accept-edits`, `approval-required`), and interaction mode (`default` or `plan`).
- **Project & Global Sharing**: Scope agents to a single project or share/import them across all projects from the project **Agents** manager.
- **Dedicated `AGENTS.md` & `SKILL.md` per Agent**:
  - Link an external workspace-relative or absolute `AGENTS.md` file (loaded fresh on every turn) and/or write built-in per-agent `AGENTS.md` instructions directly in the dialog.
  - Toggle discovered workspace `SKILL.md` files, link external skill directories/files, or author custom inline skills (`SKILL.md`) stored with the agent profile.

### 2. Team Groups, Group Chat & Personal Agent Chats

- **Team Groups & Conversation Rosters**: Organize agents into project Team Groups with a designated **Team Lead / Orchestrator** (crown badge). Each Group Chat conversation can also customize its own active agent roster and orchestrator override.
- **Dual-Channel Workflow (`group_chat` + `agent_personal`)**:
  - **Group Chat**: Shared team channel where the user, Orchestrator, and specialist agents plan, discuss, and review work concisely.
  - **Personal Agent Chat**: Dedicated 1-on-1 execution thread per agent where delegated tasks run with full tool logs and code diffs, with one-click navigation cards linking Group Chat task delegations, completions, and blockers to the agent's Personal Chat.

### 3. Team Coordination MCP Tools (`t3_team_*`)

- `t3_team_list_agents`: Inspect the active team roster, roles, models, effort options, `AGENTS.md`, skills, and personal thread IDs.
- `t3_team_create_agent` / `t3_team_update_agent` / `t3_team_delete_agent`: Allow the Orchestrator agent to create or update team agents (including model, effort options, `AGENTS.md`, skills, and group membership) on the fly.
- `t3_team_ask_agent`: Hand off the floor to a specialist agent in Group Chat and automatically return control to the Orchestrator once answered.
- `t3_team_delegate_task`: Dispatch implementation tasks to a specialist agent's Personal Chat thread and automatically post the resulting `<group_chat_summary>` back to Group Chat when the agent finishes.
- `t3_team_report_blocker`: Escalate blockers from a Personal Chat thread back to the Orchestrator in Group Chat.

### 4. Antigravity Runtime (`1.4.5`) & Trajectory Improvements

- **Effort / Thinking Level Support**: Full support for Antigravity `1.4.5` model families (`Gemini 4 Argon`, `Gemini 3.8 Flash`, `Claude Opus 5.5`, `Claude Sonnet 5.5`, `GPT-OSS 120B`) and `thinking_level` (`Low`, `Medium`, `High`) options, with automatic migration of legacy `1.3.0` `-high` / `-medium` / `-low` model IDs and live synchronization to active Personal Chat threads.
- **Cross-Model & Group Chat Trajectory Isolation**: Automatically starts a fresh native Antigravity trajectory on multi-agent Group Chat turns, model switches, or after failed runs to prevent cross-model trajectory conversion errors.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, Antigravity, and fx. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.
> - fx: install [fx](https://fx.sh) and run `fx login` on the machine running the T3 Code server ([setup guide](./docs/user/providers-fx.md))

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

#### Nix (nixpkgs)

```bash
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code
```

The package is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code)
and includes the desktop app (`t3code-desktop`) and the `t3` command.
See [Nix installation](./docs/user/install.md#nix-nixpkgs) for NixOS configuration and updates.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
