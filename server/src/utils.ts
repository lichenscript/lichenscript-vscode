import * as path from "path";

export function getSearchPathFromNode(entryDir: string): string[] {
  let currentPath = path.resolve(entryDir);
  const result: string[] = [];

  while (true) {
    const childPath = path.join(currentPath, 'node_modules');
    result.push(childPath);

    const parent = path.dirname(currentPath);
    if (parent === currentPath) {
      break;
    }
    currentPath = parent;
  }

  return result;
}
