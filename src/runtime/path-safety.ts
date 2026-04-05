import { isAbsolute, posix, relative, resolve, win32 } from "node:path";

export function assertSafeSessionIDSegment(sessionID: string): string {
  if (sessionID.length === 0) {
    throw new Error("Session ID must be a non-empty single path segment.");
  }

  if (sessionID.includes("\u0000")) {
    throw new Error("Session ID must not contain NUL bytes.");
  }

  if (sessionID === "." || sessionID === "..") {
    throw new Error(
      `Session ID '${sessionID}' must not be '.' or '..' when used as a filesystem path segment.`,
    );
  }

  if (posix.isAbsolute(sessionID) || win32.isAbsolute(sessionID)) {
    throw new Error(
      `Session ID '${sessionID}' must not be an absolute filesystem path.`,
    );
  }

  if (
    sessionID !== posix.basename(sessionID) ||
    sessionID !== win32.basename(sessionID)
  ) {
    throw new Error(
      `Session ID '${sessionID}' must resolve to exactly one filesystem path segment.`,
    );
  }

  return sessionID;
}

export function resolvePathWithinDirectory(
  directory: string,
  fileName: string,
  pathLabel: string,
): string {
  const resolvedDirectory = resolve(directory);
  const resolvedPath = resolve(resolvedDirectory, fileName);
  const relativePath = relative(resolvedDirectory, resolvedPath);

  if (
    relativePath.length === 0 ||
    relativePath === "." ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      `Resolved ${pathLabel} path '${resolvedPath}' escaped parent directory '${resolvedDirectory}'.`,
    );
  }

  return resolvedPath;
}
