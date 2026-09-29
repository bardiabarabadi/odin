/**
 * Thin wrapper around the git CLI. Uses `execFile` (never a shell) so paths
 * and revisions are passed verbatim on every platform.
 */
import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { log } from './log';

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

function gitPath(): string {
  const configured = vscode.workspace.getConfiguration('odin').get<string>('git.path');
  return configured && configured.trim() ? configured.trim() : 'git';
}

export function runGit(args: string[], cwd: string): Promise<string> {
  const exe = gitPath();
  log.info(`git ${args.join(' ')} (cwd: ${cwd})`);
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      { cwd, maxBuffer: 256 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            reject(new GitError(`Git executable not found ("${exe}"). Set "odin.git.path" to the git binary.`));
            return;
          }
          reject(new GitError((stderr || err.message).trim(), stderr));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

export interface RepoFile {
  /** Repository top-level directory (native path). */
  root: string;
  /** Path of the file relative to the repository root, `/`-separated. */
  relPath: string;
  /** Native absolute path of the file. */
  fsPath: string;
}

/**
 * Locate the repository containing `fsPath`. Uses `--show-prefix` from the
 * file's directory, which sidesteps symlink, drive-letter-case and separator
 * differences between the editor's path and git's idea of the top level.
 */
export async function locateInRepo(fsPath: string): Promise<RepoFile> {
  const dir = path.dirname(fsPath);
  let out: string;
  try {
    out = await runGit(['rev-parse', '--show-toplevel', '--show-prefix'], dir);
  } catch (err) {
    if (err instanceof GitError && /not a git repository/i.test(err.message)) {
      throw new GitError(`"${path.basename(fsPath)}" is not inside a git repository.`);
    }
    throw err;
  }
  const lines = out.split(/\r?\n/);
  const root = path.normalize(lines[0]?.trim() ?? '');
  const prefix = (lines[1] ?? '').trim();
  if (!root) throw new GitError(`Could not determine the git repository for "${fsPath}".`);
  return { root, relPath: `${prefix}${path.basename(fsPath)}`, fsPath };
}

/** Reject anything that could be parsed as a git option. */
export function assertSafeRef(ref: string): void {
  if (!ref || ref.startsWith('-') || /[\0\r\n]/.test(ref)) {
    throw new GitError(`Invalid revision: "${ref}"`);
  }
}

/** `git show <ref>:<relPath>` with a friendly error when the file is absent. */
export async function showFileAtRef(repo: RepoFile, ref: string): Promise<string> {
  assertSafeRef(ref);
  try {
    return await runGit(['show', `${ref}:${repo.relPath}`], repo.root);
  } catch (err) {
    if (err instanceof GitError) {
      if (/does not exist in|exists on disk, but not in|path .* does not exist/i.test(err.message)) {
        throw new GitError(`"${repo.relPath}" does not exist at revision "${ref}".`);
      }
      if (/unknown revision|bad revision|invalid object name|not a valid object name/i.test(err.message)) {
        throw new GitError(`Unknown revision "${ref}".`);
      }
    }
    throw err;
  }
}

export async function shortHash(root: string, ref: string): Promise<string | undefined> {
  assertSafeRef(ref);
  try {
    return (await runGit(['rev-parse', '--short', '--verify', `${ref}^{commit}`], root)).trim();
  } catch {
    return undefined;
  }
}

export async function upstreamRef(root: string): Promise<string | undefined> {
  try {
    const out = (await runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root)).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export interface CommitInfo {
  hash: string;
  author: string;
  when: string;
  subject: string;
}

export async function commitsTouching(repo: RepoFile, limit = 30): Promise<CommitInfo[]> {
  try {
    const out = await runGit(['log', '-n', String(limit), '--format=%h%x09%an%x09%ar%x09%s', '--', repo.relPath], repo.root);
    return out
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        const [hash = '', author = '', when = '', ...rest] = l.split('\t');
        return { hash, author, when, subject: rest.join('\t') };
      });
  } catch (err) {
    log.warn(`git log failed: ${String(err)}`);
    return [];
  }
}

export async function branchesAndTags(root: string): Promise<{ branches: string[]; tags: string[] }> {
  try {
    const out = await runGit(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags'], root);
    const branches: string[] = [];
    const tags: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      const ref = line.trim();
      if (ref.startsWith('refs/heads/')) branches.push(ref.slice('refs/heads/'.length));
      else if (ref.startsWith('refs/tags/')) tags.push(ref.slice('refs/tags/'.length));
    }
    return { branches, tags };
  } catch (err) {
    log.warn(`git for-each-ref failed: ${String(err)}`);
    return { branches: [], tags: [] };
  }
}
