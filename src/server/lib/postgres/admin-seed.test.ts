/**
 * What a boot is allowed to do to the `admin` account's password column:
 * seed it when the account is created, and otherwise leave the stored
 * credential alone unless ADMIN_PASSWORD_RESET asks for it.
 */
import { describe, it, expect, mock, spyOn, beforeEach, afterAll } from "bun:test";
import * as realRepositories from "./repositories";
import { logger } from "../logger";
import { planAdminPassword } from "./initialize";

type WrittenUser = {
  user_id?: string;
  username: string;
  password?: string;
  email?: string;
};

const written: WrittenUser[] = [];
let existingRow: unknown = null;

const mockSearchUser = mock(async () => existingRow);
const mockWriteUser = mock(async (user: WrittenUser) => {
  written.push(user);
  return { _id: user.user_id ?? "generated-id" };
});

mock.module("./repositories", () => ({
  ...realRepositories,
  searchUser: mockSearchUser,
  writeUser: mockWriteUser,
}));

// `mock.module` is process-global with no unmock API — hand the real module
// back so the next file in the same run does not inherit these stubs.
afterAll(() => {
  mock.module("./repositories", () => realRepositories);
});

const EXISTING_ADMIN = {
  user_id: "admin-user-id",
  username: "admin",
  email: "admin@mydomain",
};

const originalPassword = process.env.ADMIN_PASSWORD;
const originalReset = process.env.ADMIN_PASSWORD_RESET;

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

const runInitialize = async () => {
  const { initializeAdminUser } = await import("./initialize");
  await initializeAdminUser();
};

describe("planAdminPassword", () => {
  it("seeds a missing account with the configured password", () => {
    expect(
      planAdminPassword({ adminExists: false, adminPassword: "configured" })
    ).toEqual({ action: "seed", password: "configured", usingDefault: false });
  });

  it("seeds a missing account with the published default when nothing is configured", () => {
    expect(planAdminPassword({ adminExists: false })).toEqual({
      action: "seed",
      password: "inbox",
      usingDefault: true,
    });
  });

  it("leaves an existing account's password alone", () => {
    expect(
      planAdminPassword({ adminExists: true, adminPassword: "configured" })
    ).toEqual({ action: "keep", resetWithoutPassword: false });
  });

  it("applies the configured password when a reset is requested", () => {
    expect(
      planAdminPassword({
        adminExists: true,
        adminPassword: "configured",
        adminPasswordReset: "1",
      })
    ).toEqual({ action: "reset", password: "configured" });
  });

  it("refuses a reset that would install the published default", () => {
    expect(
      planAdminPassword({ adminExists: true, adminPasswordReset: "1" })
    ).toEqual({ action: "keep", resetWithoutPassword: true });
  });

  it.each(["", "0", "true", "yes"])(
    "treats ADMIN_PASSWORD_RESET=%p as no reset",
    (adminPasswordReset) => {
      expect(
        planAdminPassword({
          adminExists: true,
          adminPassword: "configured",
          adminPasswordReset,
        })
      ).toEqual({ action: "keep", resetWithoutPassword: false });
    }
  );
});

describe("initializeAdminUser", () => {
  beforeEach(() => {
    written.length = 0;
    existingRow = null;
    mockWriteUser.mockClear();
    mockSearchUser.mockClear();
    delete process.env.ADMIN_PASSWORD_RESET;
  });

  afterAll(() => {
    restore("ADMIN_PASSWORD", originalPassword);
    restore("ADMIN_PASSWORD_RESET", originalReset);
  });

  it("creates the account with the configured password on the first boot", async () => {
    process.env.ADMIN_PASSWORD = "configured";
    existingRow = null;

    await runInitialize();

    expect(written).toHaveLength(1);
    expect(written[0].username).toBe("admin");
    expect(written[0].password).toBe("configured");
  });

  it("warns that the account was created with a password published in the repository", async () => {
    delete process.env.ADMIN_PASSWORD;
    existingRow = null;
    const warnSpy = spyOn(logger, "warn");

    await runInitialize();

    expect(written[0].password).toBe("inbox");
    expect(warnSpy.mock.calls.flat().join("\n")).toContain("ADMIN_PASSWORD is not set");
    warnSpy.mockRestore();
  });

  it("sends no password on a later boot, so the stored one survives the restart", async () => {
    process.env.ADMIN_PASSWORD = "configured";
    existingRow = EXISTING_ADMIN;

    await runInitialize();

    expect(written).toHaveLength(1);
    expect(written[0].user_id).toBe(EXISTING_ADMIN.user_id);
    // An undefined password is what keeps the column out of the INSERT, and
    // therefore out of the conflict clause that would otherwise rewrite it.
    expect(written[0].password).toBeUndefined();
    // The identity write the boot does own still happens.
    expect(written[0].email).toBe(`admin@${process.env.EMAIL_DOMAIN || "localhost"}`);
  });

  it("applies the configured password when ADMIN_PASSWORD_RESET=1 asks for it", async () => {
    process.env.ADMIN_PASSWORD = "configured";
    process.env.ADMIN_PASSWORD_RESET = "1";
    existingRow = EXISTING_ADMIN;
    const warnSpy = spyOn(logger, "warn");

    await runInitialize();

    expect(written[0].password).toBe("configured");
    expect(warnSpy.mock.calls.flat().join("\n")).toContain("ADMIN_PASSWORD_RESET");
    warnSpy.mockRestore();
  });

  it("keeps the stored password when a reset is asked for with no password to apply", async () => {
    delete process.env.ADMIN_PASSWORD;
    process.env.ADMIN_PASSWORD_RESET = "1";
    existingRow = EXISTING_ADMIN;
    const warnSpy = spyOn(logger, "warn");

    await runInitialize();

    expect(written[0].password).toBeUndefined();
    expect(warnSpy.mock.calls.flat().join("\n")).toContain("ADMIN_PASSWORD is empty");
    warnSpy.mockRestore();
  });
});
