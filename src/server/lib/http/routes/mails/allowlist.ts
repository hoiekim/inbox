import { AUTH_ERROR_MESSAGE } from "server";
import {
  getAllowlistForUser,
  addAllowlistEntry,
  removeAllowlistEntry
} from "../../../postgres/repositories/spamAllowlist";
import { SpamAllowlistModel } from "../../../postgres/models/spamAllowlist";
import { Route } from "../route";

/**
 * Allowlist entry response type
 */
export interface AllowlistEntryResponse {
  id: string;
  pattern: string;
  createdAt: string;
}

export type AllowlistGetResponse = AllowlistEntryResponse[];

/**
 * Get the user's spam allowlist entries.
 */
export const getAllowlistRoute = new Route<AllowlistGetResponse>(
  "GET",
  "/allowlist",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const entries = await getAllowlistForUser(user.id);
    const response: AllowlistEntryResponse[] = entries.map((e: SpamAllowlistModel) => ({
      id: e.allowlist_id,
      pattern: e.pattern,
      createdAt: e.created_at
    }));

    return { status: "success", body: response };
  }
);

export interface AllowlistAddBody {
  pattern: string;
}

export type AllowlistAddResponse = AllowlistEntryResponse | null;

/**
 * Add an entry to the user's spam allowlist.
 * Pattern can be exact email (user@example.com) or domain wildcard (*@example.com).
 */
export const postAllowlistRoute = new Route<AllowlistAddResponse>(
  "POST",
  "/allowlist",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const body: AllowlistAddBody = req.body;
    const { pattern } = body;

    if (!pattern || typeof pattern !== "string") {
      return { status: "failed", message: "pattern is required" };
    }

    // Validate pattern format
    const isExactEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pattern);
    const isDomainWildcard = /^\*@[^\s@]+\.[^\s@]+$/.test(pattern);

    if (!isExactEmail && !isDomainWildcard) {
      return {
        status: "failed",
        message: "Pattern must be an email address (user@example.com) or domain wildcard (*@example.com)"
      };
    }

    const entry = await addAllowlistEntry(user.id, pattern);
    
    if (!entry) {
      return { status: "failed", message: "Entry already exists" };
    }

    return {
      status: "success",
      body: {
        id: entry.allowlist_id,
        pattern: entry.pattern,
        createdAt: entry.created_at
      }
    };
  }
);

export type AllowlistDeleteResponse = undefined;

/**
 * Remove an entry from the user's spam allowlist.
 */
export const deleteAllowlistRoute = new Route<AllowlistDeleteResponse>(
  "DELETE",
  "/allowlist/:pattern",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: AUTH_ERROR_MESSAGE };

    const pattern = decodeURIComponent(req.params.pattern);
    const removed = await removeAllowlistEntry(user.id, pattern);

    if (!removed) {
      return { status: "failed", message: "Entry not found" };
    }

    return { status: "success" };
  }
);
