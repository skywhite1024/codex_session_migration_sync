function isWindowsPath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || /^(\\\\|\/\/)/.test(path);
}

function normalizeDirectory(path: string): string {
  const normalized = isWindowsPath(path) ? path.replace(/\\/g, "/").toLowerCase() : path;
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

export function isWithinDirectory(cwd: string | null | undefined, root: string): boolean {
  if (!root) return true;
  if (isWindowsPath(cwd ?? "") !== isWindowsPath(root)) return false;
  const directory = normalizeDirectory(root);
  const candidate = normalizeDirectory(cwd ?? "");
  return (
    candidate === directory ||
    candidate.startsWith(directory.endsWith("/") ? directory : directory + "/")
  );
}
