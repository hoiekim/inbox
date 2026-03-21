import { ApiResponse } from "server";

const call = async <T = unknown>(path: string, options?: RequestInit): Promise<ApiResponse<T>> => {
  const method = options?.method || "GET";
  const body = options?.body;

  const init: RequestInit | undefined = options;

  if (method === "POST") {
    (init as RequestInit).headers = { "Content-Type": "application/json" };
    (init as RequestInit).body = JSON.stringify(body);
  }

  try {
    const httpResponse = await fetch(path, init);
    const response: ApiResponse<T> = await httpResponse.json();
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network or parse error";
    return { status: "error", message };
  }
};

call.get = <T>(path: string) => call<T>(path);
call.post = <T, B = unknown>(path: string, body: B) => {
  return call<T>(path, { method: "POST", body: body as BodyInit });
};
call.delete = <T>(path: string) => call<T>(path, { method: "DELETE" });

/**
 * Fetch text content (e.g., markdown files)
 */
call.text = async (path: string): Promise<string> => {
  console.log(`<GET:text> ${path}`);
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${path}: ${response.status}`);
  }
  return response.text();
};

/**
 * Fetch binary content as ArrayBuffer (e.g., file attachments)
 */
call.binary = async (path: string): Promise<ArrayBuffer> => {
  console.log(`<GET:binary> ${path}`);
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${path}: ${response.status}`);
  }
  return response.arrayBuffer();
};

/**
 * POST FormData (e.g., file uploads) and expect JSON response
 */
call.postFormData = async <T = unknown>(
  path: string,
  formData: FormData
): Promise<ApiResponse<T>> => {
  console.log(`<POST:formData> ${path}`);
  try {
    const response = await fetch(path, {
      method: "POST",
      body: formData
    });
    const result: ApiResponse<T> = await response.json();
    console.log(`<POST:formData> ${path}`, result);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network or parse error";
    console.error(`<POST:formData> ${path}`, message);
    return { status: "error", message };
  }
};

export { call };

export const read = async <T = unknown>(
  path: string,
  callback: (response: ApiResponse<T>) => void,
  options?: RequestInit
) => {
  const _method = options?.method?.toUpperCase() || "GET";

  const response = await fetch(path, options);
  const reader = response.body?.getReader();
  if (!reader) return;

  let streamBuilder = "";

  const start = async (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const push = async () => {
      try {
        const { done, value } = await reader.read();

        if (done) {
          controller.close();
          reader.releaseLock();
          return;
        }

        const text = new TextDecoder().decode(value);
        streamBuilder += text;

        if (streamBuilder.includes("\n")) {
          const splittedStream = streamBuilder.split("\n").filter((e) => e);
          splittedStream.forEach((e, i) => {
            let isError = false;

            try {
              const response: ApiResponse<T> = JSON.parse(e);
              callback(response);
            } catch (error) {
              console.error(error);
              isError = true;
            }

            if (i === splittedStream.length - 1) {
              streamBuilder = isError ? e : "";
            }
          });
        }

        controller.enqueue(value);

        push();
      } catch (error) {
        console.error(error);
      }
    };

    push();
  };

  return new ReadableStream({ start });
};
