/* eslint-disable no-case-declarations */
import {
  ImapRequest,
  ParseContext,
  ParseResult,
  SearchCriterion
} from "../types";
import {
  parseAtom,
  parseDate,
  parseNumber,
  parseSequenceSet,
  parseString,
  skipWhitespace
} from "./primitive-parsers";

/**
 * Parse SEARCH command
 */
export const parseSearch = (
  context: ParseContext
): ParseResult<ImapRequest> => {
  const criteria = parseSearchCriteria(context);

  if (!criteria.success) {
    return {
      success: false,
      error: "Invalid search criteria",
      consumed: 0
    };
  }

  return {
    success: true,
    value: {
      type: "SEARCH",
      data: { criteria: criteria.value! }
    },
    consumed: context.position
  };
};

export const parseSearchCriteria = (
  context: ParseContext
): ParseResult<SearchCriterion[]> => {
  const start = context.position;
  const criteria: SearchCriterion[] = [];

  // A top-level SEARCH is `1*(SP search-key)` — space-separated keys ANDed
  // together (RFC 3501 §6.4.4). Parse them one key at a time; NOT/OR each
  // consume a bounded number of following keys via parseSearchKey and hand
  // control back here for the rest.
  while (context.position < context.length) {
    skipWhitespace(context);
    if (context.position >= context.length) break;

    const key = parseSearchKey(context);
    if (!key.success) {
      return { success: false, error: key.error, consumed: 0 };
    }
    // A recognized atom that matches no known key yields `null` — skip it and
    // continue, preserving the loop's historical lenient behavior.
    if (key.value) criteria.push(key.value);
  }

  return {
    success: true,
    value: criteria,
    consumed: context.position - start
  };
};

/**
 * Parse exactly one top-level search-key (RFC 3501 §6.4.4). Leading whitespace
 * must already be skipped by the caller.
 *
 * Returning a single criterion (rather than looping to end-of-line as
 * parseSearchCriteria does) is what lets the bounded operators consume the
 * right number of operands: `NOT SP search-key` takes one following key, `OR
 * SP search-key SP search-key` takes two. Both then return control to the
 * top-level loop for any remaining ANDed keys — so `NOT SEEN SINCE 1-Jan-2026`
 * parses as `[NOT SEEN] AND [SINCE …]` instead of failing the old operand
 * length guard.
 *
 * Returns `null` (still `success`) for an atom that matches no known key,
 * mirroring the top-level loop's historical skip-and-continue behavior.
 */
const parseSearchKey = (
  context: ParseContext
): ParseResult<SearchCriterion | null> => {
  const start = context.position;
  const ok = (
    value: SearchCriterion | null
  ): ParseResult<SearchCriterion | null> => ({
    success: true,
    value,
    consumed: context.position - start
  });

  // Try to parse as sequence set first. A bare sequence-set is the SEQ search
  // key (RFC 3501 §6.4.4) — it refers to message sequence numbers, NOT UIDs, so
  // it gets its own type. The explicit `UID <set>` keyword (below) stays UID.
  // The handler resolves SEQ against the mailbox's seq→uid map per command.
  const sequenceSet = parseSequenceSet(context);
  if (sequenceSet.success) {
    return ok({ type: "SEQ", sequenceSet: sequenceSet.value! });
  }
  // reset position if sequence set parse failed
  context.position = start;

  const atom = parseAtom(context);
  const itemName = atom.value!.toUpperCase();

  // Handle simple items
  switch (itemName) {
    case "ALL":
      return ok({ type: "ALL" });
    case "ANSWERED":
      return ok({ type: "ANSWERED" });
    case "DELETED":
      return ok({ type: "DELETED" });
    case "FLAGGED":
      return ok({ type: "FLAGGED" });
    case "NEW":
      return ok({ type: "NEW" });
    case "OLD":
      return ok({ type: "OLD" });
    case "RECENT":
      return ok({ type: "RECENT" });
    case "SEEN":
      return ok({ type: "SEEN" });
    case "UNANSWERED":
      return ok({ type: "UNANSWERED" });
    case "UNDELETED":
      return ok({ type: "UNDELETED" });
    case "UNFLAGGED":
      return ok({ type: "UNFLAGGED" });
    case "UNSEEN":
      return ok({ type: "UNSEEN" });
    case "DRAFT":
      return ok({ type: "DRAFT" });
    case "UNDRAFT":
      return ok({ type: "UNDRAFT" });
    case "KEYWORD": {
      skipWhitespace(context);
      const keywordFlag = parseAtom(context);
      if (keywordFlag.success) {
        return ok({ type: "KEYWORD", flag: keywordFlag.value! });
      }
      return {
        success: false,
        error: "Expected flag after KEYWORD",
        consumed: 0
      };
    }
    case "UNKEYWORD": {
      skipWhitespace(context);
      const unkeywordFlag = parseAtom(context);
      if (unkeywordFlag.success) {
        return ok({ type: "UNKEYWORD", flag: unkeywordFlag.value! });
      }
      return {
        success: false,
        error: "Expected flag after UNKEYWORD",
        consumed: 0
      };
    }
    case "BEFORE": {
      skipWhitespace(context);
      const beforeDate = parseDate(context);
      if (beforeDate.success) {
        return ok({ type: "BEFORE", date: beforeDate.value! });
      }
      return {
        success: false,
        error: "Expected date after BEFORE",
        consumed: 0
      };
    }
    case "ON": {
      skipWhitespace(context);
      const onDate = parseDate(context);
      if (onDate.success) {
        return ok({ type: "ON", date: onDate.value! });
      }
      return { success: false, error: "Expected date after ON", consumed: 0 };
    }
    case "SINCE": {
      skipWhitespace(context);
      const sinceDate = parseDate(context);
      if (sinceDate.success) {
        return ok({ type: "SINCE", date: sinceDate.value! });
      }
      return {
        success: false,
        error: "Expected date after SINCE",
        consumed: 0
      };
    }
    case "SENTBEFORE": {
      skipWhitespace(context);
      const sentBeforeDate = parseDate(context);
      if (sentBeforeDate.success) {
        return ok({ type: "SENTBEFORE", date: sentBeforeDate.value! });
      }
      return {
        success: false,
        error: "Expected date after SENTBEFORE",
        consumed: 0
      };
    }
    case "SENTON": {
      skipWhitespace(context);
      const sentOnDate = parseDate(context);
      if (sentOnDate.success) {
        return ok({ type: "SENTON", date: sentOnDate.value! });
      }
      return {
        success: false,
        error: "Expected date after SENTON",
        consumed: 0
      };
    }
    case "SENTSINCE": {
      skipWhitespace(context);
      const sentSinceDate = parseDate(context);
      if (sentSinceDate.success) {
        return ok({ type: "SENTSINCE", date: sentSinceDate.value! });
      }
      return {
        success: false,
        error: "Expected date after SENTSINCE",
        consumed: 0
      };
    }
    case "FROM": {
      skipWhitespace(context);
      const fromValue = parseString(context);
      if (fromValue.success) {
        return ok({ type: "FROM", value: fromValue.value! });
      }
      return {
        success: false,
        error: "Expected text value after FROM",
        consumed: 0
      };
    }
    case "TO": {
      skipWhitespace(context);
      const toValue = parseString(context);
      if (toValue.success) {
        return ok({ type: "TO", value: toValue.value! });
      }
      return {
        success: false,
        error: "Expected text value after TO",
        consumed: 0
      };
    }
    case "CC": {
      skipWhitespace(context);
      const ccValue = parseString(context);
      if (ccValue.success) {
        return ok({ type: "CC", value: ccValue.value! });
      }
      return {
        success: false,
        error: "Expected text value after CC",
        consumed: 0
      };
    }
    case "BCC": {
      skipWhitespace(context);
      const bccValue = parseString(context);
      if (bccValue.success) {
        return ok({ type: "BCC", value: bccValue.value! });
      }
      return {
        success: false,
        error: "Expected text value after BCC",
        consumed: 0
      };
    }
    case "SUBJECT": {
      skipWhitespace(context);
      const subjectValue = parseString(context);
      if (subjectValue.success) {
        return ok({ type: "SUBJECT", value: subjectValue.value! });
      }
      return {
        success: false,
        error: "Expected text value after SUBJECT",
        consumed: 0
      };
    }
    case "BODY": {
      skipWhitespace(context);
      const bodyValue = parseString(context);
      if (bodyValue.success) {
        return ok({ type: "BODY", value: bodyValue.value! });
      }
      return {
        success: false,
        error: "Expected text value after BODY",
        consumed: 0
      };
    }
    case "TEXT": {
      skipWhitespace(context);
      const textValue = parseString(context);
      if (textValue.success) {
        return ok({ type: "TEXT", value: textValue.value! });
      }
      return {
        success: false,
        error: "Expected text value after TEXT",
        consumed: 0
      };
    }
    case "HEADER": {
      skipWhitespace(context);
      const headerField = parseString(context);
      skipWhitespace(context);
      const headerValue = parseString(context);
      if (headerField.success && headerValue.success) {
        return ok({
          type: "HEADER",
          field: headerField.value!,
          value: headerValue.value!
        });
      }
      return {
        success: false,
        error: "Expected field & value after HEADER",
        consumed: 0
      };
    }
    case "UID": {
      skipWhitespace(context);
      const uidSequenceSet = parseSequenceSet(context);
      if (uidSequenceSet.success) {
        return ok({ type: "UID", sequenceSet: uidSequenceSet.value! });
      }
      return {
        success: false,
        error: "Expected sequence set after UID",
        consumed: 0
      };
    }
    case "LARGER": {
      skipWhitespace(context);
      const largerSize = parseNumber(context);
      if (largerSize.success) {
        return ok({ type: "LARGER", size: largerSize.value! });
      }
      return {
        success: false,
        error: "Expected size after LARGER",
        consumed: 0
      };
    }
    case "SMALLER": {
      skipWhitespace(context);
      const smallerSize = parseNumber(context);
      if (smallerSize.success) {
        return ok({ type: "SMALLER", size: smallerSize.value! });
      }
      return {
        success: false,
        error: "Expected size after SMALLER",
        consumed: 0
      };
    }
    case "NOT": {
      skipWhitespace(context);
      const operand = parseSearchKey(context);
      if (operand.success && operand.value) {
        return ok({ type: "NOT", criterion: operand.value });
      }
      return {
        success: false,
        error: "Expected exactly 1 search criterion after NOT",
        consumed: 0
      };
    }
    case "OR": {
      skipWhitespace(context);
      const left = parseSearchKey(context);
      if (!left.success || !left.value) {
        return {
          success: false,
          error: "Expected exactly 2 search criteria after OR",
          consumed: 0
        };
      }
      skipWhitespace(context);
      const right = parseSearchKey(context);
      if (!right.success || !right.value) {
        return {
          success: false,
          error: "Expected exactly 2 search criteria after OR",
          consumed: 0
        };
      }
      return ok({ type: "OR", left: left.value, right: right.value });
    }
    default:
      return ok(null);
  }
};
