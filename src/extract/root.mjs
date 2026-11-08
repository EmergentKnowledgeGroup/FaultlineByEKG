// How facts.json and signals.json remember the source folder: never as a machine path, so a map committed with its code carries no home folder.
import path from 'node:path';

/** The root as the file stores it: '..' steps from the project folder up to the source folder when the project sits inside it ('.' when they are
 *  the same folder), else null. Only '..' and '.' are ever written, so no folder name from the machine reaches the file. */
export function portableRoot(root, projectDir) {
  if (!root) return null;
  const rel = path.relative(path.resolve(root), path.resolve(projectDir));      // from the source folder down to the project folder
  if (rel === '') return '.';
  if (path.isAbsolute(rel) || rel.split(path.sep)[0] === '..') return null;     // project outside the source folder: unknown here, config.json or --root names it
  return rel.split(path.sep).map(() => '..').join('/');
}

/** The source folder on this machine from a stored root: '..' style, '.', null, or an absolute path an older facts.json holds. */
export function resolveRoot(stored, projectDir) {
  if (!stored || typeof stored !== 'string') return null;
  return path.isAbsolute(stored) || /^[A-Za-z]:[\/]/.test(stored) ? stored : path.resolve(projectDir, stored);
}
