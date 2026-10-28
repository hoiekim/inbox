/** A weak validator over the exact bytes of a body. */
const bodyEtag = (body: string) => {
  const bytes = new TextEncoder().encode(body);
  const hash = new Bun.CryptoHasher("sha1").update(bytes).digest("base64").slice(0, 27);
  return `W/"${bytes.byteLength.toString(16)}-${hash}"`;
};

/** A body sent whole, tagged with an `ETag` so a revalidating client can get a 304. */
export const send = (
  body: string,
  init: { status?: number; contentType: string }
): Response =>
  new Response(body, {
    status: init.status ?? 200,
    headers: { "Content-Type": init.contentType, ETag: bodyEtag(body) },
  });

/**
 * A file streamed from disk rather than held in memory, so its `ETag` comes
 * from its size and modification time instead of a hash of its bytes.
 */
export const sendFile = (file: Bun.BunFile, init: { contentType: string }): Response =>
  new Response(file, {
    headers: {
      "Content-Type": init.contentType,
      ETag: `W/"${file.size.toString(16)}-${file.lastModified.toString(16)}"`,
    },
  });

export const json = (body: unknown, status = 200): Response =>
  send(JSON.stringify(body), { status, contentType: "application/json; charset=utf-8" });

export const text = (body: string, status = 200): Response =>
  send(body, { status, contentType: "text/plain; charset=utf-8" });

const NO_CACHE = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;

/**
 * Whether the client's cached copy, named by `If-None-Match` or
 * `If-Modified-Since`, still matches the response about to be sent.
 */
const isFresh = (requestHeaders: Headers, responseHeaders: Headers) => {
  const modifiedSince = requestHeaders.get("if-modified-since");
  const noneMatch = requestHeaders.get("if-none-match");
  if (!modifiedSince && !noneMatch) return false;
  if (NO_CACHE.test(requestHeaders.get("cache-control") ?? "")) return false;

  if (noneMatch && noneMatch !== "*") {
    const etag = responseHeaders.get("etag");
    if (!etag) return false;
    const matches = noneMatch
      .split(",")
      .map((tag) => tag.trim())
      .some((tag) => tag === etag || tag === `W/${etag}` || `W/${tag}` === etag);
    if (!matches) return false;
  }

  if (modifiedSince) {
    const lastModified = responseHeaders.get("last-modified");
    if (!lastModified || !(Date.parse(lastModified) <= Date.parse(modifiedSince))) return false;
  }
  return true;
};

/** Turns a successful GET/HEAD into a bodiless 304 when the client's copy is current. */
export const conditional = (request: Request, response: Response): Response => {
  const cacheable = request.method === "GET" || request.method === "HEAD";
  const success = response.status >= 200 && response.status < 300;
  if (!cacheable || !success || !isFresh(request.headers, response.headers)) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-type");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Response(null, { status: 304, headers });
};
