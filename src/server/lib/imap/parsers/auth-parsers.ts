/**
 * Authentication command parsing
 */

import { ParseContext, ParseResult, ImapRequest } from '../types';
import { skipWhitespace, parseString } from './primitive-parsers';

/**
 * Parse LOGIN command
 */
export const parseLogin = (context: ParseContext): ParseResult<ImapRequest> => {
  skipWhitespace(context);
  
  const username = parseString(context);
  if (!username.success) {
    return { success: false, error: 'Invalid username in LOGIN', consumed: 0 };
  }
  
  skipWhitespace(context);
  
  const password = parseString(context);
  if (!password.success) {
    return { success: false, error: 'Invalid password in LOGIN', consumed: 0 };
  }
  
  return {
    success: true,
    value: {
      type: 'LOGIN',
      data: {
        username: username.value!,
        password: password.value!
      }
    },
    consumed: context.position
  };
};

/**
 * Parse AUTHENTICATE command
 */
export const parseAuthenticate = (context: ParseContext): ParseResult<ImapRequest> => {
  skipWhitespace(context);
  
  const mechanism = parseString(context);
  if (!mechanism.success) {
    return { success: false, error: 'Invalid mechanism in AUTHENTICATE', consumed: 0 };
  }
  
  // Check for optional initial response
  let initialResponse: string | undefined;
  skipWhitespace(context);
  
  if (context.position < context.length) {
    const response = parseString(context);
    if (response.success) {
      initialResponse = response.value!;
    }
  }
  
  return {
    success: true,
    value: {
      type: 'AUTHENTICATE',
      data: {
        mechanism: mechanism.value!,
        initialResponse
      }
    },
    consumed: context.position
  };
};
