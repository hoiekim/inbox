import fs from "fs";
import path from "path";

const PARENT_SEGMENT = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

/** A hidden name such as `.env` or `.git`; `..` is the parent check's concern. */
const hasDotSegment = (decodedPath: string) =>
  decodedPath
    .split("/")
    .some((segment) => segment.length > 1 && segment.startsWith(".") && segment !== "..");

/**
 * A file served with validators, so a revalidating browser gets a 304 and the
 * asset is never re-downloaded unchanged. The server answers a `Range` request
 * itself, adding its own `Accept-Ranges`.
 */
const fileResponse = (filePath: string, stat: fs.Stats, rangeRequested: boolean): Response => {
  const file = Bun.file(filePath);
  const headers = new Headers({
    "Content-Type": file.type,
    "Cache-Control": "public, max-age=0",
    "Last-Modified": stat.mtime.toUTCString(),
    ETag: `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`,
  });
  if (!rangeRequested) headers.set("Accept-Ranges", "bytes");
  return new Response(file, { headers });
};

const statFile = async (filePath: string) => {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? stat : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The file under `root` that a GET or HEAD for `urlPath` names, or undefined
 * so the caller can fall through. Dotfiles, parent-directory segments and
 * directories are never served.
 */
export const serveStatic = async (
  root: string,
  urlPath: string,
  rangeRequested: boolean
): Promise<Response | undefined> => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || PARENT_SEGMENT.test(decoded) || hasDotSegment(decoded)) {
    return undefined;
  }

  const filePath = path.join(root, decoded.endsWith("/") ? `${decoded}index.html` : decoded);
  const stat = await statFile(filePath);
  return stat ? fileResponse(filePath, stat, rangeRequested) : undefined;
};

/** The single-page app's entry document, or undefined when the client is not built. */
export const serveIndex = async (
  root: string,
  rangeRequested: boolean
): Promise<Response | undefined> => {
  const filePath = path.join(root, "index.html");
  const stat = await statFile(filePath);
  return stat ? fileResponse(filePath, stat, rangeRequested) : undefined;
};
