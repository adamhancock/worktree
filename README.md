# @adamhancock/worktree

A CLI tool for managing Git worktrees with automated setup for development environments.

## Features

- Interactive branch selection from remote branches
- Automatic worktree creation with proper branch handling
- Copies `.env` files from the main repository
- Auto-detects package manager (pnpm, yarn, npm, bun) and installs dependencies
- Opens the new worktree in VS Code
- Configures Claude MCP servers for the new worktree

## Installation

### Global installation
```bash
npm install -g @adamhancock/worktree
```

### One-time usage with npx
```bash
npx @adamhancock/worktree
```

## Usage

### Interactive branch selection
```bash
worktree
# or with npx
npx @adamhancock/worktree
```

### Create worktree for a specific branch
```bash
worktree feature/new-feature
# or with npx
npx @adamhancock/worktree feature/new-feature
```

## How it works

1. Fetches latest branches from origin
2. Creates a new worktree in `../assurix-{branch-name}`
3. Handles existing local branches, remote branches, or creates new branches
4. Sets up branch tracking (without auto-pushing new branches)
5. Copies all `.env` files from the original repository
6. Auto-detects package manager and installs dependencies
7. Copies Claude MCP server configuration
8. Opens the new worktree in VS Code

## Requirements

- Git
- Node.js
- Package manager (pnpm, yarn, npm, or bun)
- VS Code (optional, for auto-opening)