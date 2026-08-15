/**
 * APPEND command parser
 */

import { ParseContext, ParseResult, AppendRequest } from '../types';
import { parseString, parseFlag, parseLiteral, skipWhitespace } from './primitive-parsers';

/**
 * Parse APPEND command
 * Format: APPEND mailbox [flags] [date] message
 */
export const parseAppend = (context: ParseContext): ParseResult<{ type: 'APPEND'; data: AppendRequest }> => {
  try {
    // Parse mailbox name
    const mailbox = parseString(context);
    if (!mailbox.success) {
      return { success: false, error: 'Expected mailbox name', consumed: 0 };
    }

    skipWhitespace(context);

    // Parse optional flags - simple implementation
    let flags: string[] | undefined;
    if (context.input[context.position] === '(') {
      context.position++; // Skip '('
      const flagsStr = [];
      while (context.position < context.length && context.input[context.position] !== ')') {
        if (context.input[context.position] === ' ') {
          context.position++;
          continue;
        }
        const flag = parseFlag(context);
        if (flag.success) {
          flagsStr.push(flag.value!);
        } else {
          break;
        }
      }
      if (context.input[context.position] === ')') {
        context.position++; // Skip ')'
        flags = flagsStr;
        skipWhitespace(context);
      }
    }

    // Parse optional date
    let date: string | undefined;
    if (context.input[context.position] === '"') {
      const dateResult = parseString(context);
      if (dateResult.success) {
        date = dateResult.value;
        skipWhitespace(context);
      }
    }

    // Parse the message literal. Shared with every other literal-bearing
    // command: `{N}` counts octets, so the payload arrives out-of-band on
    // `context.literals` rather than being sliced out of the UTF-16 input by
    // a byte count. Slicing it here is how the message silently lost its
    // trailing bytes whenever it held a multi-byte character.
    const literal = parseLiteral(context);
    if (!literal.success) {
      return {
        success: false,
        error: literal.error || 'Expected message literal',
        consumed: 0
      };
    }
    const message = literal.value!;

    const appendRequest: AppendRequest = {
      mailbox: mailbox.value!,
      flags,
      date,
      message
    };

    return {
      success: true,
      value: { type: 'APPEND', data: appendRequest },
      consumed: context.position
    };
  } catch (error) {
    return { success: false, error: `APPEND parse error: ${error}`, consumed: 0 };
  }
};
