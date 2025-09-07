/**
 * Main IMAP command parser entry point
 */

import { ParseContext, ParseResult, ImapRequest } from '../types';
import { parseAtom, skipWhitespace } from './primitive-parsers';
import { parseFetch } from './fetch-parsers';
import { parseLogin, parseAuthenticate } from './auth-parsers';
import { parseList, parseSelect, parseStatus, parseCreate, parseDelete, parseRename, parseSubscribe, parseUnsubscribe } from './mailbox-parsers';
import { parseSearch, parseStore, parseCopy } from './search-store-parsers';
import { parseAppend } from './append-parser';

/**
 * Parse a complete IMAP command line
 */
export const parseCommand = (line: string): ParseResult<{ tag: string; request: ImapRequest }> => {
  console.log(`[PARSER] Parsing command: "${line}"`);
  const context: ParseContext = {
    input: line.trim(),
    position: 0,
    length: line.trim().length
  };

  try {
    const tag = parseAtom(context);
    if (!tag.success || !tag.value) {
      return { success: false, error: 'Invalid tag', consumed: 0 };
    }

    skipWhitespace(context);
    
    const command = parseAtom(context);
    if (!command.success || !command.value) {
      return { success: false, error: 'Invalid command', consumed: 0 };
    }

    skipWhitespace(context);

    const request = parseImapRequest(command.value.toUpperCase(), context);
    if (!request.success) {
      return { success: false, error: request.error, consumed: 0 };
    }

    return {
      success: true,
      value: {
        tag: tag.value,
        request: request.value!
      },
      consumed: context.position
    };
  } catch (error) {
    return { success: false, error: `Parse error: ${error}`, consumed: 0 };
  }
};

/**
 * Parse IMAP request based on command type
 */
const parseImapRequest = (command: string, context: ParseContext): ParseResult<ImapRequest> => {
  switch (command) {
    case 'CAPABILITY':
      return { success: true, value: { type: 'CAPABILITY' }, consumed: context.position };
    
    case 'NOOP':
      return { success: true, value: { type: 'NOOP' }, consumed: context.position };
    
    case 'LOGOUT':
      return { success: true, value: { type: 'LOGOUT' }, consumed: context.position };
    
    case 'LOGIN':
      return parseLogin(context);
    
    case 'AUTHENTICATE':
      return parseAuthenticate(context);
    
    case 'LIST':
    case 'LSUB':
      return parseList(command, context);
    
    case 'SELECT':
      return parseSelect(false, context);
    
    case 'EXAMINE':
      return parseSelect(true, context);
    
    case 'CREATE':
      return parseCreate(context);
    
    case 'DELETE':
      return parseDelete(context);
    
    case 'RENAME':
      return parseRename(context);
    
    case 'SUBSCRIBE':
      return parseSubscribe(context);
    
    case 'UNSUBSCRIBE':
      return parseUnsubscribe(context);
    
    case 'STATUS':
      return parseStatus(context);
    
    case 'FETCH':
      return parseFetch(context);
    
    case 'SEARCH':
      return parseSearch(context);
    
    case 'STORE':
      return parseStore(context);
    
    case 'COPY':
      return parseCopy(context);
    
    case 'UID':
      return parseUid(context);
    
    case 'CHECK':
      return { success: true, value: { type: 'CHECK' }, consumed: context.position };
    
    case 'CLOSE':
      return { success: true, value: { type: 'CLOSE' }, consumed: context.position };
    
    case 'EXPUNGE':
      return { success: true, value: { type: 'EXPUNGE' }, consumed: context.position };
    
    case 'APPEND':
      return parseAppend(context);
    
    case 'IDLE':
      return parseIdle(context);
    
    default:
      return { success: false, error: `Unknown command: ${command}`, consumed: 0 };
  }
};

/**
 * Parse UID command
 */
const parseUid = (context: ParseContext): ParseResult<ImapRequest> => {
  const subCommand = parseAtom(context);
  if (!subCommand.success) {
    return { success: false, error: 'Invalid UID subcommand', consumed: 0 };
  }

  skipWhitespace(context);

  const subRequest = parseImapRequest(subCommand.value!.toUpperCase(), context);
  if (!subRequest.success) {
    return { success: false, error: subRequest.error, consumed: 0 };
  }

  return {
    success: true,
    value: {
      type: 'UID',
      data: {
        command: subCommand.value!.toUpperCase(),
        request: subRequest.value!
      }
    },
    consumed: context.position
  };
};

/**
 * Parse IDLE command
 */
const parseIdle = (context: ParseContext): ParseResult<ImapRequest> => {
  // IDLE command has no parameters
  return {
    success: true,
    value: {
      type: 'IDLE'
    },
    consumed: context.position
  };
};
