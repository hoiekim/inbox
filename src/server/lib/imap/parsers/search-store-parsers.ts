/**
 * SEARCH and STORE command parsing
 */

import {
  ParseContext,
  ParseResult,
  ImapRequest,
  SearchRequest,
  StoreRequest,
  CopyRequest,
  StoreOperation
} from "../types";
import {
  parseSequenceSet,
  skipWhitespace,
  parseString,
  parseAtom,
  parseFlag,
  peek,
  consume
} from "./primitive-parsers";

/**
 * Runtime validation for StoreOperation
 */
const isStoreOperation = (value: string): value is StoreOperation => {
  const validOperations: StoreOperation[] = [
    "FLAGS",
    "FLAGS.SILENT",
    "+FLAGS",
    "+FLAGS.SILENT",
    "-FLAGS",
    "-FLAGS.SILENT"
  ];
  return validOperations.includes(value as StoreOperation);
};

/**
 * Create a simple search criterion from string (temporary implementation)
 */
const createSearchCriterion = (criterion: string) => {
  // This should be expanded to handle all IMAP search criteria
  const upper = criterion.toUpperCase();

  switch (upper) {
    case "ALL":
      return { type: "ALL" as const };
    case "ANSWERED":
      return { type: "ANSWERED" as const };
    case "DELETED":
      return { type: "DELETED" as const };
    case "FLAGGED":
      return { type: "FLAGGED" as const };
    case "NEW":
      return { type: "NEW" as const };
    case "OLD":
      return { type: "OLD" as const };
    case "RECENT":
      return { type: "RECENT" as const };
    case "SEEN":
      return { type: "SEEN" as const };
    case "UNANSWERED":
      return { type: "UNANSWERED" as const };
    case "UNDELETED":
      return { type: "UNDELETED" as const };
    case "UNFLAGGED":
      return { type: "UNFLAGGED" as const };
    case "UNSEEN":
      return { type: "UNSEEN" as const };
    default:
      if (!Number.isNaN(+upper[0])) {
        return { type: "UID" as const, value: criterion };
      }
      // For unknown criteria, create a generic text criterion
      return { type: "TEXT" as const, value: criterion };
  }
};

/**
 * Parse SEARCH command
 */
export const parseSearch = (
  context: ParseContext
): ParseResult<ImapRequest> => {
  const criteria: any[] = [];

  while (context.position < context.length) {
    skipWhitespace(context);

    if (context.position >= context.length) break;

    const criterion = parseAtom(context);
    if (!criterion.success) {
      const str = parseString(context);
      if (str.success) {
        criteria.push(createSearchCriterion(str.value!));
      } else {
        break;
      }
    } else {
      criteria.push(createSearchCriterion(criterion.value!));
    }
  }

  return {
    success: true,
    value: {
      type: "SEARCH",
      data: { criteria }
    },
    consumed: context.position
  };
};

/**
 * Parse STORE command
 */
export const parseStore = (context: ParseContext): ParseResult<ImapRequest> => {
  const sequenceSet = parseSequenceSet(context);
  if (!sequenceSet.success) {
    return {
      success: false,
      error: "Invalid sequence set in STORE",
      consumed: 0
    };
  }

  skipWhitespace(context);

  const itemName = parseAtom(context);
  if (!itemName.success) {
    return { success: false, error: "Invalid item name in STORE", consumed: 0 };
  }

  const operation = itemName.value!.toUpperCase();

  if (!isStoreOperation(operation)) {
    return {
      success: false,
      error: `Invalid store operation: ${operation}`,
      consumed: 0
    };
  }

  const silent = operation.includes(".SILENT");

  skipWhitespace(context);

  // Parse flags list
  const flags: string[] = [];

  if (peek(context) === "(") {
    context.position++; // consume '('

    while (context.position < context.length) {
      skipWhitespace(context);

      if (peek(context) === ")") {
        context.position++; // consume ')'
        break;
      }

      const flag = parseFlag(context);
      if (!flag.success) {
        return { success: false, error: "Invalid flag in STORE", consumed: 0 };
      }

      flags.push(flag.value!);

      skipWhitespace(context);
    }
  } else {
    // Single flag without parentheses
    const flag = parseFlag(context);
    if (!flag.success) {
      return { success: false, error: "Invalid flag in STORE", consumed: 0 };
    }
    flags.push(flag.value!);
  }

  return {
    success: true,
    value: {
      type: "STORE",
      data: {
        sequenceSet: sequenceSet.value!,
        operation: operation,
        flags,
        silent
      }
    },
    consumed: context.position
  };
};

/**
 * Parse COPY command
 */
export const parseCopy = (context: ParseContext): ParseResult<ImapRequest> => {
  const sequenceSet = parseSequenceSet(context);
  if (!sequenceSet.success) {
    return {
      success: false,
      error: "Invalid sequence set in COPY",
      consumed: 0
    };
  }

  skipWhitespace(context);

  const mailbox = parseString(context);
  if (!mailbox.success) {
    return {
      success: false,
      error: "Invalid mailbox name in COPY",
      consumed: 0
    };
  }

  return {
    success: true,
    value: {
      type: "COPY",
      data: {
        sequenceSet: sequenceSet.value!,
        mailbox: mailbox.value!
      }
    },
    consumed: context.position
  };
};
