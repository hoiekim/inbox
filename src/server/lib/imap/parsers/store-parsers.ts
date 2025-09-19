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
import { parseSearchCriteria } from "./search-parsers";

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
