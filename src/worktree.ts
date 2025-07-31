#!/usr/bin/env node
import { $, echo, chalk, fs, argv } from 'zx';
import { join, dirname, resolve } from 'path';
import { select, input } from '@inquirer/prompts';
import { homedir } from 'os';

$.verbose = false;

async function isGitRepository(): Promise<boolean> {
  try {
    await $`git rev-parse --git-dir`;
    return true;
  } catch {
    return false;
  }
}

async function getRemoteBranches(): Promise<string[]> {
  echo(chalk.blue('Fetching latest branches...'));
  await $`git fetch origin`;
  
  const result = await $`git branch -r`;
  const branches = result.stdout
    .split('\n')
    .filter(line => line.trim() && !line.includes('HEAD'))
    .map(line => line.trim().replace('origin/', ''))
    .sort();
  
  return branches;
}

async function selectBranchInteractive(branches: string[]): Promise<string | null> {
  try {
    const CREATE_NEW = '+ Create new branch';
    const choices = [
      { name: CREATE_NEW, value: CREATE_NEW },
      ...branches.map(branch => ({
        name: branch,
        value: branch
      }))
    ];
    
    const selected = await select({
      message: 'Select a branch to create worktree:',
      choices
    });
    
    if (selected === CREATE_NEW) {
      const branchName = await input({
        message: 'Enter the new branch name:',
        validate: (value) => {
          if (!value.trim()) {
            return 'Branch name cannot be empty';
          }
          if (branches.includes(value)) {
            return 'Branch already exists';
          }
          return true;
        }
      });
      echo(chalk.green(`\nCreating new branch: ${branchName}`));
      return branchName;
    }
    
    echo(chalk.cyan(`\nSelected branch: ${selected}`));
    return selected;
  } catch (err) {
    echo('\nCancelled');
    return null;
  }
}

async function findEnvFiles(dir: string): Promise<string[]> {
  const result = await $`find ${dir} -name ".env*" -type f`;
  return result.stdout.split('\n').filter(Boolean);
}

async function branchExists(branchName: string, type: 'local' | 'remote'): Promise<boolean> {
  try {
    if (type === 'local') {
      await $`git show-ref --verify --quiet refs/heads/${branchName}`;
    } else {
      await $`git show-ref --verify --quiet refs/remotes/origin/${branchName}`;
    }
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(dir: string): Promise<string> {
  if (fs.existsSync(join(dir, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(join(dir, 'yarn.lock'))) {
    return 'yarn';
  }
  if (fs.existsSync(join(dir, 'package-lock.json'))) {
    return 'npm';
  }
  if (fs.existsSync(join(dir, 'bun.lockb'))) {
    return 'bun';
  }
  return 'npm'; // default
}

async function installDependencies(packageManager: string) {
  echo(chalk.blue(`Installing dependencies with ${packageManager}...`));
  
  switch (packageManager) {
    case 'pnpm':
      await $`pnpm install --frozen-lockfile`;
      break;
    case 'yarn':
      await $`yarn install --frozen-lockfile`;
      break;
    case 'bun':
      await $`bun install --frozen-lockfile`;
      break;
    case 'npm':
    default:
      await $`npm ci`;
      break;
  }
}


async function updateClaudeConfig(worktreePath: string) {
  const claudeConfigPath = join(homedir(), '.claude.json');
  
  if (!fs.existsSync(claudeConfigPath)) {
    echo(chalk.yellow('Warning: ~/.claude.json not found, skipping MCP servers configuration'));
    return;
  }
  
  try {
    const config = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf-8'));
    const sourceDir = process.cwd();
    const absoluteWorktreePath = resolve(sourceDir, worktreePath);
    
    // Check if source directory has MCP servers configured
    if (!config.projects?.[sourceDir]?.mcpServers) {
      echo('No MCP servers configured in source directory');
      return;
    }
    
    // Copy MCP servers configuration
    if (!config.projects) {
      config.projects = {};
    }
    
    if (!config.projects[absoluteWorktreePath]) {
      config.projects[absoluteWorktreePath] = {
        allowedTools: [],
        history: [],
        mcpContextUris: [],
        mcpServers: {},
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        hasTrustDialogAccepted: false,
        projectOnboardingSeenCount: 0,
        hasClaudeMdExternalIncludesApproved: false,
        hasClaudeMdExternalIncludesWarningShown: false
      };
    }
    
    // Copy the MCP servers from source directory
    config.projects[absoluteWorktreePath].mcpServers = { ...config.projects[sourceDir].mcpServers };
    
    // Write the updated configuration
    fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
    echo(chalk.green('✅ Updated ~/.claude.json with MCP servers configuration'));
  } catch (err) {
    echo(chalk.red('Failed to update Claude configuration:'), err);
  }
}

async function createWorktree(branchName?: string) {
  // Check if we're in a git repository
  if (!await isGitRepository()) {
    echo(chalk.red('Error: Not in a git repository'));
    process.exit(1);
  }

  let selectedBranch: string;

  // If no branch provided, show interactive selector
  if (!branchName) {
    const branches = await getRemoteBranches();
    
    if (branches.length === 0) {
      echo(chalk.red('No remote branches found'));
      process.exit(1);
    }

    const selected = await selectBranchInteractive(branches);
    if (!selected) {
      process.exit(0);
    }
    selectedBranch = selected;
  } else {
    selectedBranch = branchName;
  }

  // Replace forward slashes with hyphens for directory name
  const safeBranchName = selectedBranch.replace(/\//g, '-');
  const worktreePath = join('..', `assurix-${safeBranchName}`);

  echo(chalk.cyan(`Creating worktree for branch: ${selectedBranch}`));
  echo(chalk.gray(`Worktree path: ${worktreePath}`));

  // Check if worktree directory already exists
  if (fs.existsSync(worktreePath)) {
    echo(chalk.red(`Error: Directory ${worktreePath} already exists`));
    process.exit(1);
  }

  // Store the original directory
  const originalDir = process.cwd();

  // Fetch latest from origin (skip if it would cause conflicts)
  echo(chalk.blue('Fetching latest from origin...'));
  try {
    await $`git fetch origin`;
  } catch (err) {
    echo(chalk.yellow('Warning: Could not fetch from origin (this is OK if main is checked out elsewhere)'));
  }

  // Create the worktree with the appropriate branch
  try {
    if (await branchExists(selectedBranch, 'local')) {
      echo(chalk.blue(`Creating worktree with existing local branch: ${selectedBranch}`));
      await $`git worktree add ${worktreePath} ${selectedBranch}`;
    } else if (await branchExists(selectedBranch, 'remote')) {
      echo(chalk.blue(`Creating worktree from remote branch: ${selectedBranch}`));
      await $`git worktree add ${worktreePath} -b ${selectedBranch} origin/${selectedBranch}`;
    } else {
      echo(chalk.blue(`Creating worktree with new branch: ${selectedBranch}`));
      // Create new branch from origin/main to avoid checkout conflicts
      await $`git worktree add ${worktreePath} -b ${selectedBranch} origin/main`;
    }
  } catch (err) {
    echo(chalk.red(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  // Set up branch tracking for the worktree
  process.chdir(worktreePath);
  
  try {
    if (await branchExists(selectedBranch, 'remote')) {
      // For existing remote branches, ensure tracking is set
      echo(chalk.blue(`Setting upstream for ${selectedBranch} to track origin/${selectedBranch}`));
      await $`git branch --set-upstream-to=origin/${selectedBranch} ${selectedBranch}`;
    } else {
      // For new branches, set up push configuration to create upstream on first push
      echo(chalk.blue(`New branch ${selectedBranch} created locally. Configuring to push to origin/${selectedBranch}`));
      await $`git config branch.${selectedBranch}.remote origin`;
      await $`git config branch.${selectedBranch}.merge refs/heads/${selectedBranch}`;
      await $`git config push.default simple`;
    }
  } catch (err) {
    echo(chalk.yellow(`Warning: Could not set upstream tracking: ${err instanceof Error ? err.message : String(err)}`));
  }
  
  // Stay in the worktree directory for subsequent operations

  // Update Claude configuration with MCP servers
  await updateClaudeConfig(worktreePath);

  // Navigate to the new worktree (already changed during upstream setup)
  // No need to change directory again

  // Copy .env files from the original directory
  echo(chalk.blue('Copying .env files...'));
  const envFiles = await findEnvFiles(originalDir);
  
  for (const envFile of envFiles) {
    const relativePath = envFile.replace(originalDir + '/', '');
    const targetPath = join(process.cwd(), relativePath);
    const targetDir = dirname(targetPath);
    
    // Create directory structure if it doesn't exist
    await $`mkdir -p ${targetDir}`;
    
    // Copy the file (we're already in the worktree directory)
    await $`cp ${envFile} ${targetPath}`;
    echo(chalk.green(`Copied: ${relativePath}`));
  }

  // Detect package manager and install dependencies
  const packageManager = await detectPackageManager(process.cwd());
  await installDependencies(packageManager);

  // Open in VS Code
  const absoluteWorktreePath = resolve(originalDir, worktreePath);
  echo(chalk.blue(`Opening VS Code at: ${absoluteWorktreePath}`));
  try {
    await $`code ${absoluteWorktreePath}`;
  } catch (err) {
    echo(chalk.yellow('Failed to open VS Code. You can manually open the project at:'), absoluteWorktreePath);
  }

  echo(chalk.green('✅ Worktree created successfully!'));
  echo(chalk.cyan(`📁 Location: ${worktreePath}`));
  echo(chalk.cyan(`🌿 Branch: ${selectedBranch}`));
}

// Main execution
const branchName = argv._[0];
createWorktree(branchName).catch(err => {
  echo(chalk.red('Error:'), err.message);
  process.exit(1);
});