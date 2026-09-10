export function normalizeProjectPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

export function isPythonProjectPath(path: string): boolean {
  return /\.py$/i.test(normalizeProjectPath(path));
}

function codeLines(code: string): string[] {
  return code.replace(/\r\n?/g, '\n').split('\n');
}

export function preservesOriginalCode(original: string, candidate: string): boolean {
  if (original.length === 0 || original.trim().length === 0) return true;
  const originalLines = codeLines(original);

  let originalIndex = 0;
  for (const line of codeLines(candidate)) {
    if (line === originalLines[originalIndex]) originalIndex += 1;
    if (originalIndex === originalLines.length) return true;
  }

  return false;
}
