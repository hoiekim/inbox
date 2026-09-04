import { useEffect } from "react";
import { Category } from "client";
import { AccountLists, resolveSelectedAccount } from "./selectableAccounts";

/**
 * Keeps `selectedAccount` on an account the current category lists — picking
 * its first one on a fresh login, and re-anchoring a name no list contains.
 *
 * Outside Search the value is an account key, so such a name is unreachable
 * state rather than a selection: a search term left behind by a reload out of
 * Search mode, or an account whose last mail here was deleted. No row
 * highlights, the pane has nothing to render, and no affordance recovers it.
 *
 * Pass `lists` as `undefined` until the payload has loaded, so a pending fetch
 * is never read as an empty list.
 */
export const useAnchoredSelectedAccount = (
  selectedAccount: string,
  selectedCategory: Category,
  lists: AccountLists | undefined,
  setSelectedAccount: (account: string) => void
) => {
  useEffect(() => {
    if (!lists) return;
    const resolved = resolveSelectedAccount(
      selectedAccount,
      selectedCategory,
      lists
    );
    if (resolved !== null) setSelectedAccount(resolved);
  }, [selectedAccount, selectedCategory, lists]);
};
