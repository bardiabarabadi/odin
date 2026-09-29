import * as path from 'path';
import * as vscode from 'vscode';
import { findAdapter } from '../adapters';
import type { Design } from '../model/types';
import {
  branchesAndTags,
  commitsTouching,
  GitError,
  locateInRepo,
  RepoFile,
  shortHash,
  showFileAtRef,
  upstreamRef,
} from './git';

export interface BaseRevision {
  /** Revision as given to git, e.g. `HEAD~1`. */
  ref: string;
  /** Label shown in the UI, e.g. `HEAD~1 (a1b2c3d)`. */
  label: string;
  design: Design;
}

interface RefItem extends vscode.QuickPickItem {
  ref?: string;
  custom?: boolean;
}

const ENTER_REVISION = 'Enter a revision…';

async function buildItems(repo: RepoFile, defaultRef: string): Promise<RefItem[]> {
  const [upstream, commits, refs] = await Promise.all([
    upstreamRef(repo.root),
    commitsTouching(repo, 30),
    branchesAndTags(repo.root),
  ]);
  const sep = (label: string): RefItem => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const items: RefItem[] = [];
  const seen = new Set<string>();
  const add = (item: RefItem): void => {
    if (item.ref && seen.has(item.ref)) return;
    if (item.ref) seen.add(item.ref);
    items.push(item);
  };

  add({ label: '$(git-commit) ' + defaultRef, description: 'default', ref: defaultRef });
  add({ label: '$(git-commit) HEAD', description: 'last commit', ref: 'HEAD' });
  add({ label: '$(git-commit) HEAD~1', description: 'commit before last', ref: 'HEAD~1' });
  if (upstream) add({ label: '$(cloud) ' + upstream, description: 'upstream of current branch', ref: upstream });

  if (commits.length) {
    items.push(sep(`Commits touching ${path.posix.basename(repo.relPath)}`));
    for (const c of commits) {
      add({ label: '$(git-commit) ' + c.hash, description: c.subject, detail: `${c.author}, ${c.when}`, ref: c.hash });
    }
  }
  if (refs.branches.length) {
    items.push(sep('Branches'));
    for (const b of refs.branches) add({ label: '$(git-branch) ' + b, ref: b });
  }
  if (refs.tags.length) {
    items.push(sep('Tags'));
    for (const t of refs.tags) add({ label: '$(tag) ' + t, ref: t });
  }
  items.push(sep(''));
  items.push({ label: '$(edit) ' + ENTER_REVISION, custom: true, alwaysShow: true });
  return items;
}

async function pickRef(repo: RepoFile): Promise<string | undefined> {
  const defaultRef = vscode.workspace.getConfiguration('odin').get<string>('compare.defaultRef') || 'HEAD';
  const picked = await vscode.window.showQuickPick(buildItems(repo, defaultRef), {
    title: `Odin: compare ${path.posix.basename(repo.relPath)} with…`,
    placeHolder: 'Select a git revision to use as the comparison base',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return undefined;
  if (!picked.custom) return picked.ref;
  const typed = await vscode.window.showInputBox({
    title: 'Odin: compare with revision',
    prompt: 'Any git revision: commit hash, branch, tag, HEAD~3, origin/main, …',
    value: defaultRef,
    validateInput: (v) => (!v.trim() ? 'Enter a revision' : v.trim().startsWith('-') ? 'Revisions cannot start with "-"' : undefined),
  });
  return typed?.trim() || undefined;
}

/**
 * Ask the user for a base revision of `uri`, load the file at that revision
 * and parse it with the adapter that matches the current file.
 * Returns undefined when the user cancels. Throws on errors.
 */
export async function pickAndLoadBase(uri: vscode.Uri, presetRef?: string): Promise<BaseRevision | undefined> {
  if (uri.scheme !== 'file') {
    throw new GitError('Comparison requires a file saved on disk inside a git repository.');
  }
  const repo = await locateInRepo(uri.fsPath);
  const ref = presetRef ?? (await pickRef(repo));
  if (!ref) return undefined;
  return loadBase(repo, ref);
}

export async function loadBaseForRef(uri: vscode.Uri, ref: string): Promise<BaseRevision> {
  const repo = await locateInRepo(uri.fsPath);
  return loadBase(repo, ref);
}

async function loadBase(repo: RepoFile, ref: string): Promise<BaseRevision> {
  const text = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Odin: reading ${repo.relPath} at ${ref}` },
    () => showFileAtRef(repo, ref),
  );
  const adapter = findAdapter(text, repo.fsPath);
  if (!adapter) {
    throw new Error(`"${repo.relPath}" at revision "${ref}" is not a recognized block design.`);
  }
  const design = adapter.parse(text, revisionUri(repo.fsPath, ref).toString());
  const firstError = design.diagnostics.find((d) => d.severity === 'error');
  if (design.cells.length === 0 && firstError) {
    throw new Error(`"${repo.relPath}" at revision "${ref}" could not be parsed: ${firstError.message}`);
  }
  const hash = await shortHash(repo.root, ref);
  const label = hash && hash !== ref ? `${ref} (${hash})` : ref;
  return { ref, label, design };
}

/** URI scheme for read-only views of a file at a git revision. */
export const REVISION_SCHEME = 'odin-git';

interface RevisionQuery {
  ref: string;
  fsPath: string;
}

export function revisionUri(fsPath: string, ref: string): vscode.Uri {
  const query: RevisionQuery = { ref, fsPath };
  return vscode.Uri.file(fsPath).with({ scheme: REVISION_SCHEME, query: JSON.stringify(query) });
}

/**
 * Serves `odin-git:` documents so that "reveal source" on an object that only
 * exists in the comparison base opens the file as it was at that revision.
 */
export class RevisionContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = JSON.parse(uri.query) as RevisionQuery;
    const repo = await locateInRepo(q.fsPath);
    return showFileAtRef(repo, q.ref);
  }
}
