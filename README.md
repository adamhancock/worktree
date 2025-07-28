# Worktree Manager

A CLI tool for managing Git worktrees with automated setup for development environments.

## Features

- Interactive branch selection from remote branches
- Automatic worktree creation with proper branch handling
- Copies `.env` files from the main repository
- Installs dependencies using pnpm
- Builds the project automatically
- Opens the new worktree in VS Code

## Installation

```bash
pnpm install
```

## Usage

### Create worktree for a specific branch
```bash
./src/worktree.ts branch-name
```

### Interactive branch selection
```bash
./src/worktree.ts
```

## How it works

1. Fetches latest branches from origin
2. Creates a new worktree in `../assurix-{branch-name}`
3. Handles existing local branches, remote branches, or creates new branches
4. Copies all `.env` files from the original repository
5. Runs `pnpm install` to install dependencies
6. Runs `pnpm build` to build the project
7. Opens the new worktree in VS Code

## Requirements

- Git
- Node.js
- pnpm
- VS Code (optional, for auto-opening)