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
  parseNumber,
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
 * Parse the optional STORE modifier group (RFC 7162 §3.1.3):
 *   store-modifier = "UNCHANGEDSINCE" SP mod-sequence-valzer
 * It sits between the sequence set and the item name — `STORE 7,5,9
 * (UNCHANGEDSINCE 320162338) +FLAGS.SILENT (\Deleted)`. Unambiguous to detect:
 * an item name is an atom and never starts with "(". CONDSTORE defines only
 * UNCHANGEDSINCE, so any other modifier is a client error (BAD) rather than
 * something to ignore — silently dropping it would apply an unconditional
 * STORE where the client asked for a conditional one.
 */
const parseStoreModifiers = (
  context: ParseContext
): ParseResult<{ unchangedSince?: number }> => {
  skipWhitespace(context);
  if (peek(context) !== "(") {
    return { success: true, value: {}, consumed: context.position };
  }
  context.position++; // consume '('

  let unchangedSince: number | undefined;
  while (context.position < context.length) {
    skipWhitespace(context);
    if (peek(context) === ")") {
      context.position++; // consume ')'
      return { success: true, value: { unchangedSince }, consumed: context.position };
    }

    const name = parseAtom(context);
    if (!name.success) {
      return { success: false, error: "Invalid STORE modifier", consumed: 0 };
    }
    if (name.value!.toUpperCase() !== "UNCHANGEDSINCE") {
      return {
        success: false,
        error: `Unknown STORE modifier: ${name.value}`,
        consumed: 0
      };
    }
    skipWhitespace(context);
    const modseq = parseNumber(context);
    if (!modseq.success) {
      return {
        success: false,
        error: "Invalid UNCHANGEDSINCE mod-sequence",
        consumed: 0
      };
    }
    unchangedSince = modseq.value!;
  }

  return { success: false, error: "Unterminated STORE modifier group", consumed: 0 };
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

  const modifiers = parseStoreModifiers(context);
  if (!modifiers.success) {
    return { success: false, error: modifiers.error, consumed: 0 };
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
        unchangedSince: modifiers.value!.unchangedSince
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
