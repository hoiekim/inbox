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

  it("reports `unreadable` with both paths when the certificate is absent", () => {
    const absentCert = ssl.absentPath("absent-cert.pem");
    ssl.use(absentCert, ssl.keyPath);
    expect(getTlsCredentials()).toEqual({
      state: "unreadable",
      cert: absentCert,
      key: ssl.keyPath
    });
    expect(isTlsAvailable()).toBe(false);
  });

  it("reports `unreadable` when the key is absent", () => {
    const absentKey = ssl.absentPath("absent-key.pem");
    ssl.use(ssl.certPath, absentKey);
    expect(getTlsCredentials()).toEqual({
      state: "unreadable",
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

  it("reports `unreadable` for a file that exists but the process cannot read", () => {
    // The shape a Let's Encrypt `privkey.pem` at 0640 root:root takes for a
    // non-root app user: `existsSync` says yes, `readFileSync` throws EACCES.
    // root bypasses the permission bits entirely, so there is nothing to assert
    // when the suite runs as root (some CI containers do).
    if (process.getuid?.() === 0) return;
    const lockedKey = ssl.absentPath("locked-key.pem");
    writeFileSync(lockedKey, "key", { mode: 0o000 });
    ssl.use(ssl.certPath, lockedKey);
    expect(getTlsCredentials()).toEqual({
      state: "unreadable",
      cert: ssl.certPath,
      key: lockedKey
    });
    expect(isTlsAvailable()).toBe(false);
    rmSync(lockedKey);
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
