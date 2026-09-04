/**
 * Basic IMAP parsing primitives
 */

import {
  ParseContext,
  ParseResult,
  SequenceSet,
  SequenceRange
} from "../types";

/**
 * Parse an IMAP atom (unquoted string)
 */
export const parseAtom = (context: ParseContext): ParseResult<string> => {
  const start = context.position;

  while (context.position < context.length) {
    const char = context.input[context.position];

    // ATOM-CHAR = <any CHAR except atom-specials>
    // atom-specials = "(" / ")" / "{" / SP / CTL / list-wildcards / quoted-specials
    if (
      char === " " ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === '"' ||
      char === "\\" ||
      char === "\r" ||
      char === "\n" ||
      char === "*" ||
      char === "%" ||
      char.charCodeAt(0) < 32
    ) {
      break;
    }

    context.position++;
  }

  if (context.position === start) {
    return { success: false, error: "Expected atom", consumed: 0 };
  }

  return {
    success: true,
    value: context.input.substring(start, context.position),
    consumed: context.position - start
  };
};

export const parseDate = (context: ParseContext): ParseResult<Date> => {
  const start = context.position;
  const atom = parseAtom(context);
  const date = new Date(atom.value!);
  if (!atom.success) {
    return {
      success: atom.success,
      error: atom.error,
      consumed: atom.consumed
    };
  }
  if (isNaN(date.getTime())) {
    context.position = start; // reset position on failure
    return { success: false, error: "Invalid date", consumed: 0 };
  }
  return { success: true, value: date, consumed: atom.consumed };
};

/**
 * Parse an IMAP flag (can start with backslash)
 */
export const parseFlag = (context: ParseContext): ParseResult<string> => {
  const start = context.position;

  // Handle flags that start with backslash
  if (peek(context) === "\\") {
    context.position++;
  }

  while (context.position < context.length) {
    const char = context.input[context.position];

    // Stop at whitespace, parentheses, or other delimiters
    if (
      char === " " ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === '"' ||
      char === "\r" ||
      char === "\n" ||
      char === "*" ||
      char === "%" ||
      char.charCodeAt(0) < 32
    ) {
      break;
    }

    context.position++;
  }

  if (context.position === start) {
    return { success: false, error: "Expected flag", consumed: 0 };
  }

  return {
    success: true,
    value: context.input.substring(start, context.position),
    consumed: context.position - start
  };
};

/**
 * Parse an RFC 3501 §4.3 literal — `{N}` (synchronizing) or RFC 7888 `{N+}`
 * (LITERAL+, non-synchronizing).
 *
 * `N` counts OCTETS. `input` is a UTF-16 string, where one octet is not one
 * code unit, so the payload is NOT sliced out of `input` here: the handler has
 * already taken exactly N bytes off the socket buffer, decoded them, and
 * queued the result on `context.literals`. This consumes the marker and shifts
 * the matching payload. A marker with no queued payload means the caller built
 * the context by hand rather than through the handler — a bug, not a
 * recoverable input.
 */
export const parseLiteral = (context: ParseContext): ParseResult<string> => {
  const start = context.position;

  if (peek(context) !== "{") {
    return { success: false, error: "Expected literal", consumed: 0 };
  }

  const closing = context.input.indexOf("}", start + 1);
  if (closing === -1) {
    return { success: false, error: "Unterminated literal", consumed: 0 };
  }

  const sizeToken = context.input.substring(start + 1, closing);
  if (!/^\d+\+?$/.test(sizeToken)) {
    return { success: false, error: "Invalid literal size", consumed: 0 };
  }

  if (!context.literals?.length) {
    return { success: false, error: "Missing literal payload", consumed: 0 };
  }

  context.position = closing + 1;
  return {
    success: true,
    value: context.literals.shift(),
    consumed: context.position - start
  };
};

/**
 * Parse a string (quoted, literal, or atom)
 */
export const parseString = (context: ParseContext): ParseResult<string> => {
  if (peek(context) === '"') {
    return parseQuotedString(context);
  }

  if (peek(context) === "{") {
    return parseLiteral(context);
  }

  return parseAtom(context);
};

/**
 * Parse a list-mailbox token (RFC 3501 list-mailbox rule). Like an atom, but
 * the list wildcards "*" and "%" are valid characters here, so a pattern such
 * as "INBOX/%" or "%/accounts" is captured whole rather than truncated at the
 * first wildcard. A quoted form is also accepted.
 */
export const parseListMailbox = (
  context: ParseContext
): ParseResult<string> => {
  if (peek(context) === '"') {
    return parseQuotedString(context);
  }

  const start = context.position;

  while (context.position < context.length) {
    const char = context.input[context.position];
    if (
      char === " " ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === '"' ||
      char === "\\" ||
      char === "\r" ||
      char === "\n" ||
      char.charCodeAt(0) < 32
    ) {
      break;
    }
    context.position++;
  }

  if (context.position === start) {
    return { success: false, error: "Expected list mailbox", consumed: 0 };
  }

  return {
    success: true,
    value: context.input.substring(start, context.position),
    consumed: context.position - start
  };
};

/**
 * Parse a quoted string
 */
export const parseQuotedString = (
  context: ParseContext
): ParseResult<string> => {
  if (!consume(context, '"')) {
    return { success: false, error: "Expected opening quote", consumed: 0 };
  }

  const start = context.position;
  let result = "";

  while (context.position < context.length) {
    const char = context.input[context.position];

    if (char === '"') {
      context.position++;
      return {
        success: true,
        value: result,
        consumed: context.position - start + 1
      };
    }

    if (char === "\\" && context.position + 1 < context.length) {
      context.position++;
      result += context.input[context.position];
    } else {
      result += char;
    }

    context.position++;
  }

  return { success: false, error: "Unterminated quoted string", consumed: 0 };
};

/**
 * Parse a sequence set (e.g., "1:5,7,9:*")
 */
export const parseSequenceSet = (
  context: ParseContext
): ParseResult<SequenceSet> => {
  const ranges: SequenceRange[] = [];

  while (context.position < context.length) {
    skipWhitespace(context);

    if (context.position >= context.length) break;

    // Parse first number or *
    let start: number;
    if (peek(context) === "*") {
      start = Number.MAX_SAFE_INTEGER;
      context.position++;
    } else {
      const num = parseNumber(context);
      if (!num.success) break;
      start = num.value!;
    }

    // Check for range (:)
    if (peek(context) === ":") {
      context.position++; // consume ':'

      let end: number;
      if (peek(context) === "*") {
        end = Number.MAX_SAFE_INTEGER;
        context.position++;
      } else {
        const num = parseNumber(context);
        if (!num.success) {
          return { success: false, error: "Invalid range end", consumed: 0 };
        }
        end = num.value!;
      }

      ranges.push({ start, end });
    } else {
      // Single number
      ranges.push({ start });
    }

    // Check for comma (more sequences)
    skipWhitespace(context);
    if (peek(context) === ",") {
      context.position++;
    } else {
      break;
    }
  }

  if (ranges.length === 0) {
    return { success: false, error: "Empty sequence set", consumed: 0 };
  }

  return {
    success: true,
    value: {
      type: "sequence", // Default to sequence, will be overridden for UID commands
      ranges
    },
    consumed: context.position
  };
};

/**
 * Parse a number
 */
export const parseNumber = (context: ParseContext): ParseResult<number> => {
  const start = context.position;

  while (context.position < context.length) {
    const char = context.input[context.position];
    if (char >= "0" && char <= "9") {
      context.position++;
    } else {
      break;
    }
  }

  if (context.position === start) {
    return { success: false, error: "Expected number", consumed: 0 };
  }

  const value = parseInt(context.input.substring(start, context.position), 10);
  return { success: true, value, consumed: context.position - start };
};

/**
 * Skip whitespace characters
 */
export const skipWhitespace = (context: ParseContext): void => {
  while (
    context.position < context.length &&
    context.input[context.position] === " "
  ) {
    context.position++;
  }
};

/**
 * Peek at the current character without consuming it
 */
export const peek = (context: ParseContext): string => {
  return context.position < context.length
    ? context.input[context.position]
    : "";
};

/**
 * Consume expected string, return true if successful
 */
export const consume = (context: ParseContext, expected: string): boolean => {
  if (
    context.input.substring(
      context.position,
      context.position + expected.length
    ) === expected
  ) {
    context.position += expected.length;
    return true;
  }
  return false;
};

/**
 * Parse a CONDSTORE modifier group — the parenthesized `(NAME <mod-sequence>)`
 * that trails a FETCH sequence set (RFC 4551 §3.3.1) or sits between a STORE
 * sequence set and its item name (RFC 7162 §3.1.3). Both grammars admit
 * exactly one modifier name, so an unrecognized one is a client error rather
 * than something to ignore: dropping it silently would run an unconditional
 * command where the client asked for a conditional one.
 *
 * Absent group is the normal case and parses as `undefined`, not a failure.
 *
 * ```ts
 * const modifier = parseModifierGroup(context, "FETCH", "CHANGEDSINCE");
 * ```
 */
export const parseModifierGroup = (
  context: ParseContext,
  command: string,
  modifier: string
): ParseResult<number | undefined> => {
  skipWhitespace(context);
  if (peek(context) !== "(") {
    return { success: true, value: undefined, consumed: context.position };
  }
  context.position++;

  let value: number | undefined;
  while (context.position < context.length) {
    skipWhitespace(context);
    if (peek(context) === ")") {
      context.position++;
      return { success: true, value, consumed: context.position };
    }

    const name = parseAtom(context);
    if (!name.success) {
      return { success: false, error: `Invalid ${command} modifier`, consumed: 0 };
    }
    if (name.value!.toUpperCase() !== modifier) {
      return {
        success: false,
        error: `Unknown ${command} modifier: ${name.value}`,
        consumed: 0
      };
    }
    skipWhitespace(context);
    const modseq = parseNumber(context);
    if (!modseq.success) {
      return {
        success: false,
        error: `${modifier} requires a mod-sequence value`,
        consumed: 0
      };
    }
    value = modseq.value!;
  }

  return {
    success: false,
    error: `Unterminated ${command} modifier group`,
    consumed: 0
  };
};
