#!/usr/bin/env tsx
import { $ } from 'zx';
import { existsSync, readFileSync, writeFileSync } from 'fs';
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
  console.log('Fetching latest branches...');
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
      console.log(`\nCreating new branch: ${branchName}`);
      return branchName;
    }
    
    console.log(`\nSelected branch: ${selected}`);
    return selected;
  } catch (err) {
    console.log('\nCancelled');
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

async function updateClaudeConfig(worktreePath: string) {
  const claudeConfigPath = join(homedir(), '.claude.json');
  
  if (!existsSync(claudeConfigPath)) {
    console.log('Warning: ~/.claude.json not found, skipping MCP servers configuration');
    return;
  }
  
  try {
    const config = JSON.parse(readFileSync(claudeConfigPath, 'utf-8'));
    const sourceDir = process.cwd();
    const absoluteWorktreePath = resolve(sourceDir, worktreePath);
    
    // Check if source directory has MCP servers configured
    if (!config.projects?.[sourceDir]?.mcpServers) {
      console.log('No MCP servers configured in source directory');
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
    writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
    console.log('✅ Updated ~/.claude.json with MCP servers configuration');
  } catch (err) {
    console.error('Failed to update Claude configuration:', err);
  }
}

async function createWorktree(branchName?: string) {
  // Check if we're in a git repository
  if (!await isGitRepository()) {
    console.error('Error: Not in a git repository');
    process.exit(1);
  }

  let selectedBranch: string;

  // If no branch provided, show interactive selector
  if (!branchName) {
    const branches = await getRemoteBranches();
    
    if (branches.length === 0) {
      console.error('No remote branches found');
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

  console.log(`Creating worktree for branch: ${selectedBranch}`);
  console.log(`Worktree path: ${worktreePath}`);

  // Check if worktree directory already exists
  if (existsSync(worktreePath)) {
    console.error(`Error: Directory ${worktreePath} already exists`);
    process.exit(1);
  }

  // Store the original directory
  const originalDir = process.cwd();

  // Fetch latest from origin (skip if it would cause conflicts)
  console.log('Fetching latest from origin...');
  try {
    await $`git fetch origin`;
  } catch (err) {
    console.log('Warning: Could not fetch from origin (this is OK if main is checked out elsewhere)');
  }

  // Create the worktree with the appropriate branch
  try {
    if (await branchExists(selectedBranch, 'local')) {
      console.log(`Creating worktree with existing local branch: ${selectedBranch}`);
      await $`git worktree add ${worktreePath} ${selectedBranch}`;
    } else if (await branchExists(selectedBranch, 'remote')) {
      console.log(`Creating worktree from remote branch: ${selectedBranch}`);
      await $`git worktree add ${worktreePath} -b ${selectedBranch} origin/${selectedBranch}`;
    } else {
      console.log(`Creating worktree with new branch: ${selectedBranch}`);
      // Create new branch from origin/main to avoid checkout conflicts
      await $`git worktree add ${worktreePath} -b ${selectedBranch} origin/main`;
    }
  } catch (err) {
    console.error(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Set up branch tracking for the worktree
  const currentDir = process.cwd();
  process.chdir(worktreePath);
  
  try {
    if (!await branchExists(selectedBranch, 'remote')) {
      // For new branches, set upstream to track origin/main
      console.log(`Setting upstream for new branch ${selectedBranch} to track origin/main`);
      await $`git branch --set-upstream-to=origin/main ${selectedBranch}`;
    } else {
      // For existing remote branches, ensure tracking is set
      console.log(`Setting upstream for ${selectedBranch} to track origin/${selectedBranch}`);
      await $`git branch --set-upstream-to=origin/${selectedBranch} ${selectedBranch}`;
    }
  } catch (err) {
    console.log(`Warning: Could not set upstream tracking: ${err instanceof Error ? err.message : String(err)}`);
  }
  
  // Stay in the worktree directory for subsequent operations

  // Update Claude configuration with MCP servers
  await updateClaudeConfig(worktreePath);

  // Navigate to the new worktree (already changed during upstream setup)
  // No need to change directory again

  // Copy .env files from the original directory
  console.log('Copying .env files...');
  const envFiles = await findEnvFiles(originalDir);
  
  for (const envFile of envFiles) {
    const relativePath = envFile.replace(originalDir + '/', '');
    const targetPath = join(process.cwd(), relativePath);
    const targetDir = dirname(targetPath);
    
    // Create directory structure if it doesn't exist
    await $`mkdir -p ${targetDir}`;
    
    // Copy the file (we're already in the worktree directory)
    await $`cp ${envFile} ${targetPath}`;
    console.log(`Copied: ${relativePath}`);
  }

  // Install dependencies
  console.log('Installing dependencies with pnpm...');
  await $`pnpm install`;

  // Build the project
  console.log('Building project with pnpm...');
  await $`pnpm build`;

  // Open in VS Code
  const absoluteWorktreePath = resolve(originalDir, worktreePath);
  console.log(`Opening VS Code at: ${absoluteWorktreePath}`);
  try {
    await $`code ${absoluteWorktreePath}`;
  } catch (err) {
    console.log('Failed to open VS Code. You can manually open the project at:', absoluteWorktreePath);
  }

  console.log('✅ Worktree created successfully!');
  console.log(`📁 Location: ${worktreePath}`);
  console.log(`🌿 Branch: ${selectedBranch}`);
}

// Main execution
const branchName = process.argv[2];
createWorktree(branchName).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});