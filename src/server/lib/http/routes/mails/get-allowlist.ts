import { getAllowlistForUser, SpamAllowlistModel } from "server";
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
export const getSpamAllowlistRoute = new Route<AllowlistGetResponse>(
  "GET",
  "/spam-allowlist",
  async (req) => {
    const user = req.session.user!;

    const entries = await getAllowlistForUser(user.id);
    const response: AllowlistEntryResponse[] = entries.map((e: SpamAllowlistModel) => ({
      id: e.allowlist_id,
      pattern: e.pattern,
      createdAt: e.created_at
    }));

    return { status: "success", body: response };
  }
);
