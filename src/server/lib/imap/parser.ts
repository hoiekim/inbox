/**
 * IMAP command parser - converts raw IMAP commands to typed interfaces
 */

import {
  ImapCommand,
  ImapRequest,
  FetchRequest,
  FetchDataItem,
  BodyFetch,
  BodySection,
  PartialRange,
  SequenceSet,
  SequenceRange,
  SearchRequest,
  SearchCriterion,
  StoreRequest,
  StoreOperation,
  StatusItem,
  ParseContext,
  ParseResult
} from './types';

export class ImapParser {
  /**
   * Parse a complete IMAP command line
   */
  static parseCommand(line: string): ParseResult<{ tag: string; request: ImapRequest }> {
    const context: ParseContext = {
      input: line.trim(),
      position: 0,
      length: line.trim().length
    };

    try {
      const tag = this.parseAtom(context);
      if (!tag.success || !tag.value) {
        return { success: false, error: 'Invalid tag', consumed: 0 };
      }

      this.skipWhitespace(context);
      
      const command = this.parseAtom(context);
      if (!command.success || !command.value) {
        return { success: false, error: 'Invalid command', consumed: 0 };
      }

      this.skipWhitespace(context);

      const request = this.parseImapRequest(command.value.toUpperCase(), context);
      if (!request.success) {
        return { success: false, error: request.error, consumed: 0 };
      }

      return {
        success: true,
        value: { tag: tag.value, request: request.value! },
        consumed: context.position
      };
    } catch (error) {
      return { success: false, error: `Parse error: ${error}`, consumed: 0 };
    }
  }

  /**
   * Parse IMAP request based on command type
   */
  private static parseImapRequest(command: string, context: ParseContext): ParseResult<ImapRequest> {
    switch (command) {
      case 'CAPABILITY':
        return { success: true, value: { type: 'CAPABILITY' }, consumed: 0 };
      
      case 'NOOP':
        return { success: true, value: { type: 'NOOP' }, consumed: 0 };
      
      case 'LOGIN':
        return this.parseLogin(context);
      
      case 'AUTHENTICATE':
        return this.parseAuthenticate(context);
      
      case 'LIST':
      case 'LSUB':
        return this.parseList(command, context);
      
      case 'SELECT':
        return this.parseSelect(false, context);
      
      case 'EXAMINE':
        return this.parseSelect(true, context);
      
      case 'CREATE':
        return this.parseCreate(context);
      
      case 'DELETE':
        return this.parseDelete(context);
      
      case 'RENAME':
        return this.parseRename(context);
      
      case 'SUBSCRIBE':
        return this.parseSubscribe(context);
      
      case 'UNSUBSCRIBE':
        return this.parseUnsubscribe(context);
      
      case 'STATUS':
        return this.parseStatus(context);
      
      case 'APPEND':
        return { success: false, error: 'APPEND not implemented', consumed: 0 };
      
      case 'CHECK':
        return { success: true, value: { type: 'CHECK' }, consumed: 0 };
      
      case 'FETCH':
        return this.parseFetch(context);
      
      case 'SEARCH':
        return this.parseSearch(context);
      
      case 'STORE':
        return this.parseStore(context);
      
      case 'COPY':
        return this.parseCopy(context);
      
      case 'UID':
        return this.parseUid(context);
      
      case 'CLOSE':
        return { success: true, value: { type: 'CLOSE' }, consumed: 0 };
      
      case 'EXPUNGE':
        return { success: true, value: { type: 'EXPUNGE' }, consumed: 0 };
      
      case 'LOGOUT':
        return { success: true, value: { type: 'LOGOUT' }, consumed: 0 };
      
      default:
        return { success: false, error: `Unknown command: ${command}`, consumed: 0 };
    }
  }

  /**
   * Parse LOGIN command
   */
  private static parseLogin(context: ParseContext): ParseResult<ImapRequest> {
    const username = this.parseString(context);
    if (!username.success) {
      return { success: false, error: 'Invalid username', consumed: 0 };
    }

    this.skipWhitespace(context);

    const password = this.parseString(context);
    if (!password.success) {
      return { success: false, error: 'Invalid password', consumed: 0 };
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
  }

  /**
   * Parse FETCH command
   */
  private static parseFetch(context: ParseContext): ParseResult<ImapRequest> {
    const sequenceSet = this.parseSequenceSet(context);
    if (!sequenceSet.success) {
      return { success: false, error: 'Invalid sequence set', consumed: 0 };
    }

    this.skipWhitespace(context);

    const dataItems = this.parseFetchDataItems(context);
    if (!dataItems.success) {
      return { success: false, error: 'Invalid fetch data items', consumed: 0 };
    }

    return {
      success: true,
      value: {
        type: 'FETCH',
        data: {
          sequenceSet: sequenceSet.value!,
          dataItems: dataItems.value!
        }
      },
      consumed: context.position
    };
  }

  /**
   * Parse fetch data items (FLAGS, ENVELOPE, BODY[], etc.)
   */
  private static parseFetchDataItems(context: ParseContext): ParseResult<FetchDataItem[]> {
    const items: FetchDataItem[] = [];
    
    // Handle parenthesized list or single item
    const isParenthesized = this.peek(context) === '(';
    if (isParenthesized) {
      this.consume(context, '(');
      this.skipWhitespace(context);
    }

    while (context.position < context.length && this.peek(context) !== ')') {
      const item = this.parseFetchDataItem(context);
      if (!item.success) {
        return { success: false, error: item.error, consumed: 0 };
      }
      
      items.push(item.value!);
      this.skipWhitespace(context);
    }

    if (isParenthesized) {
      if (!this.consume(context, ')')) {
        return { success: false, error: 'Expected closing parenthesis', consumed: 0 };
      }
    }

    return { success: true, value: items, consumed: context.position };
  }

  /**
   * Parse individual fetch data item
   */
  private static parseFetchDataItem(context: ParseContext): ParseResult<FetchDataItem> {
    const atom = this.parseAtom(context);
    if (!atom.success) {
      return { success: false, error: 'Expected fetch data item', consumed: 0 };
    }

    const itemType = atom.value!.toUpperCase();

    switch (itemType) {
      case 'FLAGS':
        return { success: true, value: { type: 'FLAGS' }, consumed: 0 };
      
      case 'ENVELOPE':
        return { success: true, value: { type: 'ENVELOPE' }, consumed: 0 };
      
      case 'BODYSTRUCTURE':
        return { success: true, value: { type: 'BODYSTRUCTURE' }, consumed: 0 };
      
      case 'UID':
        return { success: true, value: { type: 'UID' }, consumed: 0 };
      
      case 'INTERNALDATE':
        return { success: true, value: { type: 'INTERNALDATE' }, consumed: 0 };
      
      case 'RFC822.SIZE':
        return { success: true, value: { type: 'RFC822.SIZE' }, consumed: 0 };
      
      case 'RFC822':
        return {
          success: true,
          value: {
            type: 'BODY',
            peek: false,
            section: { type: 'FULL' }
          },
          consumed: 0
        };
      
      case 'RFC822.HEADER':
        return {
          success: true,
          value: {
            type: 'BODY',
            peek: false,
            section: { type: 'HEADER' }
          },
          consumed: 0
        };
      
      case 'RFC822.TEXT':
        return {
          success: true,
          value: {
            type: 'BODY',
            peek: false,
            section: { type: 'TEXT' }
          },
          consumed: 0
        };
      
      default:
        // Check for BODY[...] or BODY.PEEK[...] patterns
        if (itemType.startsWith('BODY')) {
          return this.parseBodyFetch(atom.value!, context);
        }
        
        return { success: false, error: `Unknown fetch data item: ${itemType}`, consumed: 0 };
    }
  }

  /**
   * Parse BODY[...] fetch items
   */
  private static parseBodyFetch(bodyExpr: string, context: ParseContext): ParseResult<BodyFetch> {
    // Parse BODY[section]<partial> or BODY.PEEK[section]<partial>
    const bodyMatch = bodyExpr.match(/^BODY(\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/i);
    if (!bodyMatch) {
      return { success: false, error: 'Invalid BODY expression', consumed: 0 };
    }

    const [, peekStr, sectionStr, startStr, lengthStr] = bodyMatch;
    const peek = !!peekStr;
    
    // Parse section
    const section = this.parseBodySection(sectionStr);
    if (!section.success) {
      return { success: false, error: section.error, consumed: 0 };
    }

    // Parse partial range if present
    let partial: PartialRange | undefined;
    if (startStr && lengthStr) {
      partial = {
        start: parseInt(startStr, 10),
        length: parseInt(lengthStr, 10)
      };
    }

    return {
      success: true,
      value: {
        type: 'BODY',
        peek,
        section: section.value!,
        partial
      },
      consumed: 0
    };
  }

  /**
   * Parse body section (TEXT, HEADER, 1, 1.2, etc.)
   */
  private static parseBodySection(sectionStr: string): ParseResult<BodySection> {
    if (!sectionStr || sectionStr === '') {
      return { success: true, value: { type: 'FULL' }, consumed: 0 };
    }

    const section = sectionStr.toUpperCase();

    if (section === 'TEXT') {
      return { success: true, value: { type: 'TEXT' }, consumed: 0 };
    }

    if (section === 'HEADER') {
      return { success: true, value: { type: 'HEADER' }, consumed: 0 };
    }

    // Check for MIME part number (1, 1.2, 2.1.3, etc.)
    if (/^\d+(\.\d+)*$/.test(section)) {
      return {
        success: true,
        value: {
          type: 'MIME_PART',
          partNumber: section
        },
        consumed: 0
      };
    }

    // Check for part with subsection (1.HEADER, 2.TEXT, etc.)
    const partMatch = section.match(/^(\d+(?:\.\d+)*)\.(HEADER|TEXT|MIME)$/);
    if (partMatch) {
      const [, partNumber, subSection] = partMatch;
      return {
        success: true,
        value: {
          type: 'MIME_PART',
          partNumber,
          subSection: subSection as 'HEADER' | 'TEXT' | 'MIME'
        },
        consumed: 0
      };
    }

    return { success: false, error: `Invalid body section: ${sectionStr}`, consumed: 0 };
  }

  /**
   * Parse sequence set (1, 1:3, 1,3,5, 1:*, etc.)
   */
  private static parseSequenceSet(context: ParseContext): ParseResult<SequenceSet> {
    const ranges: SequenceRange[] = [];
    const atom = this.parseAtom(context);
    
    if (!atom.success) {
      return { success: false, error: 'Expected sequence set', consumed: 0 };
    }

    const parts = atom.value!.split(',');
    
    for (const part of parts) {
      if (part.includes(':')) {
        const [startStr, endStr] = part.split(':');
        const start = parseInt(startStr, 10);
        
        if (isNaN(start)) {
          return { success: false, error: 'Invalid sequence number', consumed: 0 };
        }

        if (endStr === '*') {
          ranges.push({ start });
        } else {
          const end = parseInt(endStr, 10);
          if (isNaN(end)) {
            return { success: false, error: 'Invalid sequence number', consumed: 0 };
          }
          ranges.push({ start, end });
        }
      } else {
        const num = parseInt(part, 10);
        if (isNaN(num)) {
          return { success: false, error: 'Invalid sequence number', consumed: 0 };
        }
        ranges.push({ start: num, end: num });
      }
    }

    return {
      success: true,
      value: {
        type: 'sequence',
        ranges
      },
      consumed: 0
    };
  }

  // Helper parsing methods
  private static parseAtom(context: ParseContext): ParseResult<string> {
    const start = context.position;
    
    while (context.position < context.length) {
      const char = context.input[context.position];
      if (/[\s\(\)\{\}\%\*\"\\\x00-\x1f\x7f-\xff]/.test(char)) {
        break;
      }
      context.position++;
    }

    if (context.position === start) {
      return { success: false, error: 'Expected atom', consumed: 0 };
    }

    return {
      success: true,
      value: context.input.substring(start, context.position),
      consumed: context.position - start
    };
  }

  private static parseString(context: ParseContext): ParseResult<string> {
    if (this.peek(context) === '"') {
      return this.parseQuotedString(context);
    } else {
      return this.parseAtom(context);
    }
  }

  private static parseQuotedString(context: ParseContext): ParseResult<string> {
    if (!this.consume(context, '"')) {
      return { success: false, error: 'Expected opening quote', consumed: 0 };
    }

    const start = context.position;
    let result = '';

    while (context.position < context.length) {
      const char = context.input[context.position];
      
      if (char === '"') {
        context.position++;
        return { success: true, value: result, consumed: context.position - start + 1 };
      }
      
      if (char === '\\' && context.position + 1 < context.length) {
        context.position++;
        result += context.input[context.position];
      } else {
        result += char;
      }
      
      context.position++;
    }

    return { success: false, error: 'Unterminated quoted string', consumed: 0 };
  }

  private static skipWhitespace(context: ParseContext): void {
    while (context.position < context.length && /\s/.test(context.input[context.position])) {
      context.position++;
    }
  }

  private static peek(context: ParseContext): string {
    return context.position < context.length ? context.input[context.position] : '';
  }

  private static consume(context: ParseContext, expected: string): boolean {
    if (context.position < context.length && context.input[context.position] === expected) {
      context.position++;
      return true;
    }
    return false;
  }

  // Placeholder implementations for other commands
  private static parseList(command: string, context: ParseContext): ParseResult<ImapRequest> {
    const reference = this.parseString(context);
    if (!reference.success) {
      return { success: false, error: 'Invalid reference name', consumed: 0 };
    }

    this.skipWhitespace(context);

    const pattern = this.parseString(context);
    if (!pattern.success) {
      return { success: false, error: 'Invalid pattern', consumed: 0 };
    }

    return {
      success: true,
      value: {
        type: command as 'LIST' | 'LSUB',
        data: {
          reference: reference.value!,
          pattern: pattern.value!
        }
      },
      consumed: context.position
    };
  }

  private static parseSelect(readOnly: boolean, context: ParseContext): ParseResult<ImapRequest> {
    const mailbox = this.parseString(context);
    if (!mailbox.success) {
      return { success: false, error: 'Invalid mailbox name', consumed: 0 };
    }

    return {
      success: true,
      value: {
        type: readOnly ? 'EXAMINE' : 'SELECT',
        data: { mailbox: mailbox.value!, readOnly }
      },
      consumed: context.position
    };
  }

  private static parseSearch(context: ParseContext): ParseResult<ImapRequest> {
    // Basic SEARCH implementation - parse remaining as criteria
    const criteria: SearchCriterion[] = [];
    
    // For now, just consume the rest as a simple ALL criterion
    // TODO: Implement full SEARCH criteria parsing
    while (context.position < context.length) {
      const atom = this.parseAtom(context);
      if (!atom.success) break;
      
      const criterion = atom.value!.toUpperCase();
      switch (criterion) {
        case 'ALL':
          criteria.push({ type: 'ALL' });
          break;
        case 'ANSWERED':
          criteria.push({ type: 'ANSWERED' });
          break;
        case 'DELETED':
          criteria.push({ type: 'DELETED' });
          break;
        case 'FLAGGED':
          criteria.push({ type: 'FLAGGED' });
          break;
        case 'NEW':
          criteria.push({ type: 'NEW' });
          break;
        case 'OLD':
          criteria.push({ type: 'OLD' });
          break;
        case 'RECENT':
          criteria.push({ type: 'RECENT' });
          break;
        case 'SEEN':
          criteria.push({ type: 'SEEN' });
          break;
        case 'UNANSWERED':
          criteria.push({ type: 'UNANSWERED' });
          break;
        case 'UNDELETED':
          criteria.push({ type: 'UNDELETED' });
          break;
        case 'UNFLAGGED':
          criteria.push({ type: 'UNFLAGGED' });
          break;
        case 'UNSEEN':
          criteria.push({ type: 'UNSEEN' });
          break;
        case 'DRAFT':
          criteria.push({ type: 'DRAFT' });
          break;
        case 'UNDRAFT':
          criteria.push({ type: 'UNDRAFT' });
          break;
        default:
          // For unknown criteria, just add as ALL for now
          criteria.push({ type: 'ALL' });
          break;
      }
      
      this.skipWhitespace(context);
    }

    if (criteria.length === 0) {
      criteria.push({ type: 'ALL' });
    }

    return {
      success: true,
      value: {
        type: 'SEARCH',
        data: { criteria }
      },
      consumed: context.position
    };
  }

  private static parseStore(context: ParseContext): ParseResult<ImapRequest> {
    const sequenceSet = this.parseSequenceSet(context);
    if (!sequenceSet.success) {
      return { success: false, error: 'Invalid sequence set', consumed: 0 };
    }

    this.skipWhitespace(context);

    const operation = this.parseAtom(context);
    if (!operation.success) {
      return { success: false, error: 'Invalid store operation', consumed: 0 };
    }

    this.skipWhitespace(context);

    // Parse flags - can be parenthesized or not
    const flags: string[] = [];
    const isParenthesized = this.peek(context) === '(';
    
    if (isParenthesized) {
      this.consume(context, '(');
      this.skipWhitespace(context);
    }

    while (context.position < context.length && this.peek(context) !== ')') {
      const flag = this.parseAtom(context);
      if (!flag.success) break;
      
      flags.push(flag.value!);
      this.skipWhitespace(context);
    }

    if (isParenthesized) {
      this.consume(context, ')');
    }

    const operationStr = operation.value!.toUpperCase();
    const silent = operationStr.includes('.SILENT');

    return {
      success: true,
      value: {
        type: 'STORE',
        data: {
          sequenceSet: sequenceSet.value!,
          operation: operationStr as StoreOperation,
          flags,
          silent
        }
      },
      consumed: context.position
    };
  }

  private static parseCopy(context: ParseContext): ParseResult<ImapRequest> {
    const sequenceSet = this.parseSequenceSet(context);
    if (!sequenceSet.success) {
      return { success: false, error: 'Invalid sequence set', consumed: 0 };
    }

    this.skipWhitespace(context);

    const mailbox = this.parseString(context);
    if (!mailbox.success) {
      return { success: false, error: 'Invalid mailbox name', consumed: 0 };
    }

    return {
      success: true,
      value: {
        type: 'COPY',
        data: {
          sequenceSet: sequenceSet.value!,
          mailbox: mailbox.value!
        }
      },
      consumed: context.position
    };
  }

  private static parseUid(context: ParseContext): ParseResult<ImapRequest> {
    const subCommand = this.parseAtom(context);
    if (!subCommand.success) {
      return { success: false, error: 'UID requires subcommand', consumed: 0 };
    }

    this.skipWhitespace(context);

    const cmd = subCommand.value!.toUpperCase();
    let subRequest: ImapRequest;

    switch (cmd) {
      case 'FETCH':
        const fetchResult = this.parseFetch(context);
        if (!fetchResult.success) {
          return fetchResult;
        }
        // Mark the sequence set as UID-based
        if (fetchResult.value!.type === 'FETCH') {
          fetchResult.value!.data.sequenceSet.type = 'uid';
        }
        subRequest = fetchResult.value!;
        break;

      case 'SEARCH':
        const searchResult = this.parseSearch(context);
        if (!searchResult.success) {
          return searchResult;
        }
        subRequest = searchResult.value!;
        break;

      case 'STORE':
        const storeResult = this.parseStore(context);
        if (!storeResult.success) {
          return storeResult;
        }
        // Mark the sequence set as UID-based
        if (storeResult.value!.type === 'STORE') {
          storeResult.value!.data.sequenceSet.type = 'uid';
        }
        subRequest = storeResult.value!;
        break;

      case 'COPY':
        const copyResult = this.parseCopy(context);
        if (!copyResult.success) {
          return copyResult;
        }
        // Mark the sequence set as UID-based
        if (copyResult.value!.type === 'COPY') {
          copyResult.value!.data.sequenceSet.type = 'uid';
        }
        subRequest = copyResult.value!;
        break;

      default:
        return { success: false, error: `Unknown UID subcommand: ${cmd}`, consumed: 0 };
    }

    return {
      success: true,
      value: {
        type: 'UID',
        data: {
          command: cmd,
          request: subRequest
        }
      },
      consumed: context.position
    };
  }

  private static parseAuthenticate(context: ParseContext): ParseResult<ImapRequest> {
    const mechanism = this.parseAtom(context);
    if (!mechanism.success) {
      return { success: false, error: 'AUTHENTICATE requires mechanism', consumed: 0 };
    }

    this.skipWhitespace(context);

    // Optional initial response
    let initialResponse: string | undefined;
    if (context.position < context.length) {
      const response = this.parseString(context);
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
  }

  private static parseStatus(context: ParseContext): ParseResult<ImapRequest> {
    const mailbox = this.parseString(context);
    if (!mailbox.success) {
      return { success: false, error: 'STATUS requires mailbox name', consumed: 0 };
    }

    this.skipWhitespace(context);

    // Parse status items in parentheses
    if (!this.consume(context, '(')) {
      return { success: false, error: 'STATUS requires parenthesized item list', consumed: 0 };
    }

    this.skipWhitespace(context);

    const items: StatusItem[] = [];
    while (context.position < context.length && this.peek(context) !== ')') {
      const item = this.parseAtom(context);
      if (!item.success) break;

      const itemType = item.value!.toUpperCase();
      if (['MESSAGES', 'RECENT', 'UIDNEXT', 'UIDVALIDITY', 'UNSEEN'].includes(itemType)) {
        items.push(itemType as StatusItem);
      }

      this.skipWhitespace(context);
    }

    if (!this.consume(context, ')')) {
      return { success: false, error: 'Expected closing parenthesis', consumed: 0 };
    }

    return {
      success: true,
      value: {
        type: 'STATUS',
        data: {
          mailbox: mailbox.value!,
          items
        }
      },
      consumed: context.position
    };
  }

  private static parseCreate(context: ParseContext): ParseResult<ImapRequest> {
    const mailbox = this.parseString(context);
    if (!mailbox.success) {
      return { success: false, error: 'CREATE requires mailbox name', consumed: 0 };
    }

    return {
      success: true,
      value: {
        type: 'CREATE',
        data: { mailbox: mailbox.value! }
      },
      consumed: context.position
    };
  }

  private static parseDelete(context: ParseContext): ParseResult<ImapRequest> {
    const mailbox = this.parseString(context);
    if (!mailbox.success) {
      return { success: false, error: 'DELETE requires mailbox name', consumed: 0 };
    }

    return {
      success: true,
      value: {
        type: 'DELETE',
        data: { mailbox: mailbox.value! }
      },
      consumed: context.position
    };
  }

  private static parseRename(context: ParseContext): ParseResult<ImapRequest> {
    const oldName = this.parseString(context);
    if (!oldName.success) {
      return { success: false, error: 'RENAME requires old mailbox name', consumed: 0 };
    }

    this.skipWhitespace(context);

    const newName = this.parseString(context);
    if (!newName.success) {
      return { success: false, error: 'RENAME requires new mailbox name', consumed: 0 };
    }

    return {
      success: true,
      value: {
        type: 'RENAME',
        data: {
          oldName: oldName.value!,
          newName: newName.value!
        }
      },
      consumed: context.position
    };
  }

  private static parseSubscribe(context: ParseContext): ParseResult<ImapRequest> {
    const mailbox = this.parseString(context);
    if (!mailbox.success) {
      return { success: false, error: 'SUBSCRIBE requires mailbox name', consumed: 0 };
    }

    return {
      success: true,
      value: {
        type: 'SUBSCRIBE',
        data: { mailbox: mailbox.value! }
      },
      consumed: context.position
    };
  }

  private static parseUnsubscribe(context: ParseContext): ParseResult<ImapRequest> {
    const mailbox = this.parseString(context);
    if (!mailbox.success) {
      return { success: false, error: 'UNSUBSCRIBE requires mailbox name', consumed: 0 };
    }

    return {
      success: true,
      value: {
        type: 'UNSUBSCRIBE',
        data: { mailbox: mailbox.value! }
      },
      consumed: context.position
    };
  }
}
