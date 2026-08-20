/**
 * SEARCH and STORE command parsing
 */

import {
  ParseContext,
  ParseResult,
  ImapRequest,
  StoreOperation
} from "../types";
import {
  parseSequenceSet,
  skipWhitespace,
  parseString,
  parseAtom,
  parseFlag,
  parseModifierGroup,
  peek
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

  // RFC 7162 §3.1.3: an optional `(UNCHANGEDSINCE <modseq>)` group sits
  // between the sequence set and the item name. Unambiguous to detect — an
  // item name is an atom and never starts with "(".
  const unchangedSince = parseModifierGroup(context, "STORE", "UNCHANGEDSINCE");
  if (!unchangedSince.success) {
    return { success: false, error: unchangedSince.error, consumed: 0 };
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
        silent,
        unchangedSince: unchangedSince.value
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

/**
 * Parse MOVE command (RFC 6851). Same wire shape as COPY — a sequence
 * set followed by a target mailbox name.
 */
export const parseMove = (context: ParseContext): ParseResult<ImapRequest> => {
  const sequenceSet = parseSequenceSet(context);
  if (!sequenceSet.success) {
    return {
      success: false,
      error: "Invalid sequence set in MOVE",
      consumed: 0
    };
  }

  skipWhitespace(context);

  const mailbox = parseString(context);
  if (!mailbox.success) {
    return {
      success: false,
      error: "Invalid mailbox name in MOVE",
      consumed: 0
    };
  }

  return {
    success: true,
    value: {
      type: "MOVE",
      data: {
        sequenceSet: sequenceSet.value!,
        mailbox: mailbox.value!
      }
    },
    consumed: context.position
  };
};
