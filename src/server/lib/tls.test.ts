import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { writeFileSync, rmSync } from "fs";
import { createTlsEnvFixture } from "test-helpers";
import { getTlsCredentials, isTlsAvailable } from "./tls";

describe("getTlsCredentials", () => {
  let ssl: ReturnType<typeof createTlsEnvFixture>;

  beforeAll(() => {
    ssl = createTlsEnvFixture();
  });

  afterEach(() => ssl.restore());

  afterAll(() => ssl.cleanup());

  it("reports `unconfigured` when neither variable is set", () => {
    ssl.use(undefined, undefined);
    expect(getTlsCredentials()).toEqual({ state: "unconfigured" });
    expect(isTlsAvailable()).toBe(false);
  });

  it("reports `unconfigured` when only the certificate is set", () => {
    ssl.use(ssl.certPath, undefined);
    expect(getTlsCredentials()).toEqual({ state: "unconfigured" });
    expect(isTlsAvailable()).toBe(false);
  });

  it("reports `unconfigured` for an empty-string path", () => {
    ssl.use(ssl.certPath, "");
    expect(getTlsCredentials()).toEqual({ state: "unconfigured" });
    expect(isTlsAvailable()).toBe(false);
  });

  it("reports `missing-files` with both paths when the certificate is absent", () => {
    const absentCert = ssl.absentPath("absent-cert.pem");
    ssl.use(absentCert, ssl.keyPath);
    expect(getTlsCredentials()).toEqual({
      state: "missing-files",
      cert: absentCert,
      key: ssl.keyPath
    });
    expect(isTlsAvailable()).toBe(false);
  });

  it("reports `missing-files` when the key is absent", () => {
    const absentKey = ssl.absentPath("absent-key.pem");
    ssl.use(ssl.certPath, absentKey);
    expect(getTlsCredentials()).toEqual({
      state: "missing-files",
      cert: ssl.certPath,
      key: absentKey
    });
    expect(isTlsAvailable()).toBe(false);
  });

  it("reports `available` with both paths when both files exist", () => {
    ssl.use(ssl.certPath, ssl.keyPath);
    expect(getTlsCredentials()).toEqual({
      state: "available",
      cert: ssl.certPath,
      key: ssl.keyPath
    });
    expect(isTlsAvailable()).toBe(true);
  });

  it("re-reads the filesystem on every call so a renewed certificate is picked up", () => {
    const laterCert = ssl.absentPath("later-cert.pem");
    ssl.use(laterCert, ssl.keyPath);
    expect(isTlsAvailable()).toBe(false);
    writeFileSync(laterCert, "cert");
    expect(isTlsAvailable()).toBe(true);
    rmSync(laterCert);
  });
});
