import { AUTH_ERROR_MESSAGE } from "server";
import { getAllowlistForUser } from "../../../postgres/repositories/spamAllowlist";
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
