/**
 * TypeScript interfaces for IMAP protocol requests and responses
 */

// IMAP type definitions

// IMAP-specific request interfaces
export interface SearchRequest {
  criteria: SearchCriterion[];
}

export interface StoreRequest {
  sequenceSet: SequenceSet;
  operation: StoreOperation;
  flags: string[];
  silent?: boolean;
}

export type StoreOperation =
  | "FLAGS"
  | "FLAGS.SILENT"
  | "+FLAGS"
  | "+FLAGS.SILENT"
  | "-FLAGS"
  | "-FLAGS.SILENT";

export interface CopyRequest {
  sequenceSet: SequenceSet;
  mailbox: string;
}

export interface AppendRequest {
  mailbox: string;
  flags?: string[];
  date?: string;
  message: string;
}

// Response data interfaces using existing models
export interface StatusResponseData {
  mailbox: string;
  items: Array<{
    attribute: "MESSAGES" | "RECENT" | "UIDNEXT" | "UIDVALIDITY" | "UNSEEN";
    value: number;
  }>;
}

export interface ListResponseData {
  flags: string[];
  delimiter: string;
  mailbox: string;
}

export interface FetchResponseData {
  uid?: number;
  flags?: string[];
  envelope?: string;
  bodystructure?: string;
  body?: Record<string, string>;
  size?: number;
}

export interface SearchResponseData {
  results: number[];
}

// Union type for all possible untagged response data
export type UntaggedResponseData =
  | { type: "EXISTS"; count: number }
  | { type: "RECENT"; count: number }
  | { type: "EXPUNGE"; sequenceNumber: number }
  | { type: "FETCH"; sequenceNumber: number; data: FetchResponseData }
  | { type: "SEARCH"; data: SearchResponseData }
  | { type: "LIST"; data: ListResponseData }
  | { type: "LSUB"; data: ListResponseData }
  | { type: "STATUS"; data: StatusResponseData }
  | { type: "FLAGS"; flags: string[] }
  | { type: "BYE"; message: string }
  | { type: "CAPABILITY"; capabilities: string[] };

// Basic IMAP command structure
export interface ImapCommand {
  tag: string;
  command: string;
  args: string[];
}

// Sequence set for message selection
export interface SequenceSet {
  type: "sequence" | "uid";
  ranges: SequenceRange[];
}

export interface SequenceRange {
  start: number;
  end?: number; // undefined means single message
}

// FETCH data items
export interface FetchRequest {
  sequenceSet: SequenceSet;
  dataItems: FetchDataItem[];
}

export type FetchDataItem =
  | EnvelopeFetch
  | FlagsFetch
  | BodyStructureFetch
  | BodyFetch
  | UidFetch
  | InternalDateFetch
  | Rfc822Fetch
  | Rfc822HeaderFetch
  | Rfc822SizeFetch
  | Rfc822TextFetch;

export interface EnvelopeFetch {
  type: "ENVELOPE";
}

export interface FlagsFetch {
  type: "FLAGS";
}

export interface BodyStructureFetch {
  type: "BODYSTRUCTURE";
}

export interface UidFetch {
  type: "UID";
}

export interface InternalDateFetch {
  type: "INTERNALDATE";
}

export interface Rfc822Fetch {
  type: "RFC822";
}

export interface Rfc822HeaderFetch {
  type: "RFC822.HEADER";
}

export interface Rfc822SizeFetch {
  type: "RFC822.SIZE";
}

export interface Rfc822TextFetch {
  type: "RFC822.TEXT";
}

// Body fetch requests with all variations
export interface BodyFetch {
  type: "BODY";
  peek: boolean; // true for BODY.PEEK, false for BODY
  section: BodySection;
  partial?: PartialRange;
}

export type BodySection =
  | FullBodySection
  | HeaderSection
  | TextSection
  | MimePartSection
  | HeaderFieldsSection;

export interface FullBodySection {
  type: "FULL"; // BODY[] or RFC822
}

export interface HeaderSection {
  type: "HEADER"; // BODY[HEADER] or RFC822.HEADER
}

export interface TextSection {
  type: "TEXT"; // BODY[TEXT] or RFC822.TEXT
}

export interface MimePartSection {
  type: "MIME_PART";
  partNumber: string; // e.g., "1", "1.2", "2.1.3"
  subSection?: "HEADER" | "TEXT" | "MIME"; // BODY[1.HEADER], BODY[1.TEXT], BODY[1.MIME]
}

export interface HeaderFieldsSection {
  type: "HEADER_FIELDS";
  not?: boolean; // true for HEADER.FIELDS.NOT
  fields: string[]; // field names to include/exclude
}

export interface PartialRange {
  start: number;
  length: number;
}

// SEARCH criteria
export interface SearchRequest {
  criteria: SearchCriterion[];
  charset?: string;
}

export type SearchCriterion =
  | AllCriterion
  | AnsweredCriterion
  | DeletedCriterion
  | FlaggedCriterion
  | NewCriterion
  | OldCriterion
  | RecentCriterion
  | SeenCriterion
  | UnAnsweredCriterion
  | UnDeletedCriterion
  | UnFlaggedCriterion
  | UnSeenCriterion
  | DraftCriterion
  | UnDraftCriterion
  | KeywordCriterion
  | UnKeywordCriterion
  | BeforeCriterion
  | OnCriterion
  | SinceCriterion
  | SentBeforeCriterion
  | SentOnCriterion
  | SentSinceCriterion
  | FromCriterion
  | ToCriterion
  | CcCriterion
  | BccCriterion
  | SubjectCriterion
  | BodyCriterion
  | TextCriterion
  | HeaderCriterion
  | UidCriterion
  | LargerCriterion
  | SmallerCriterion
  | NotCriterion
  | OrCriterion;

export interface AllCriterion {
  type: "ALL";
}
export interface AnsweredCriterion {
  type: "ANSWERED";
}
export interface DeletedCriterion {
  type: "DELETED";
}
export interface FlaggedCriterion {
  type: "FLAGGED";
}
export interface NewCriterion {
  type: "NEW";
}
export interface OldCriterion {
  type: "OLD";
}
export interface RecentCriterion {
  type: "RECENT";
}
export interface SeenCriterion {
  type: "SEEN";
}
export interface UnAnsweredCriterion {
  type: "UNANSWERED";
}
export interface UnDeletedCriterion {
  type: "UNDELETED";
}
export interface UnFlaggedCriterion {
  type: "UNFLAGGED";
}
export interface UnSeenCriterion {
  type: "UNSEEN";
}
export interface DraftCriterion {
  type: "DRAFT";
}
export interface UnDraftCriterion {
  type: "UNDRAFT";
}

export interface KeywordCriterion {
  type: "KEYWORD";
  flag: string;
}
export interface UnKeywordCriterion {
  type: "UNKEYWORD";
  flag: string;
}

export interface BeforeCriterion {
  type: "BEFORE";
  date: Date;
}
export interface OnCriterion {
  type: "ON";
  date: Date;
}
export interface SinceCriterion {
  type: "SINCE";
  date: Date;
}
export interface SentBeforeCriterion {
  type: "SENTBEFORE";
  date: Date;
}
export interface SentOnCriterion {
  type: "SENTON";
  date: Date;
}
export interface SentSinceCriterion {
  type: "SENTSINCE";
  date: Date;
}

export interface FromCriterion {
  type: "FROM";
  value: string;
}
export interface ToCriterion {
  type: "TO";
  value: string;
}
export interface CcCriterion {
  type: "CC";
  value: string;
}
export interface BccCriterion {
  type: "BCC";
  value: string;
}
export interface SubjectCriterion {
  type: "SUBJECT";
  value: string;
}
export interface BodyCriterion {
  type: "BODY";
  value: string;
}
export interface TextCriterion {
  type: "TEXT";
  value: string;
}

export interface HeaderCriterion {
  type: "HEADER";
  field: string;
  value: string;
}

export interface UidCriterion {
  type: "UID";
  sequenceSet: SequenceSet;
}

export interface LargerCriterion {
  type: "LARGER";
  size: number;
}
export interface SmallerCriterion {
  type: "SMALLER";
  size: number;
}

export interface NotCriterion {
  type: "NOT";
  criterion: SearchCriterion;
}

export interface OrCriterion {
  type: "OR";
  left: SearchCriterion;
  right: SearchCriterion;
}

// STORE request
export interface StoreRequest {
  sequenceSet: SequenceSet;
  operation: StoreOperation;
  flags: string[];
  silent?: boolean; // true for .SILENT operations
}

// COPY request
export interface CopyRequest {
  sequenceSet: SequenceSet;
  mailbox: string;
}

// Mailbox operations
export interface SelectRequest {
  mailbox: string;
  readOnly?: boolean; // true for EXAMINE
}

export interface ListRequest {
  reference: string;
  pattern: string;
}

export interface StatusRequest {
  mailbox: string;
  items: StatusItem[];
}

export type StatusItem =
  | "MESSAGES"
  | "RECENT"
  | "UIDNEXT"
  | "UIDVALIDITY"
  | "UNSEEN";

// Authentication
export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthenticateRequest {
  mechanism: string;
  initialResponse?: string;
}

// Parsed IMAP request (top-level)
export type ImapRequest =
  | { type: "CAPABILITY" }
  | { type: "NOOP" }
  | { type: "LOGIN"; data: LoginRequest }
  | { type: "AUTHENTICATE"; data: AuthenticateRequest }
  | { type: "LIST"; data: ListRequest }
  | { type: "LSUB"; data: ListRequest }
  | { type: "SELECT"; data: SelectRequest }
  | { type: "EXAMINE"; data: SelectRequest }
  | { type: "CREATE"; data: { mailbox: string } }
  | { type: "DELETE"; data: { mailbox: string } }
  | { type: "RENAME"; data: { oldName: string; newName: string } }
  | { type: "SUBSCRIBE"; data: { mailbox: string } }
  | { type: "UNSUBSCRIBE"; data: { mailbox: string } }
  | { type: "STATUS"; data: StatusRequest }
  | { type: "APPEND"; data: AppendRequest }
  | { type: "IDLE" }
  | { type: "CHECK" }
  | { type: "CLOSE" }
  | { type: "EXPUNGE" }
  | { type: "SEARCH"; data: SearchRequest }
  | { type: "FETCH"; data: FetchRequest }
  | { type: "STORE"; data: StoreRequest }
  | { type: "COPY"; data: CopyRequest }
  | { type: "MOVE"; data: CopyRequest }  // MOVE uses same structure as COPY (RFC 6851)
  | { type: "UID"; data: { command: string; request: ImapRequest } }
  | { type: "ID" }
  | { type: "DONE" }
  | { type: "LOGOUT" }
  | { type: "STARTTLS" };

// Response types for better type safety
export interface ImapResponse {
  tag: string;
  status: "OK" | "NO" | "BAD";
  message: string;
  data?: unknown;
}

export interface UntaggedResponse {
  type:
    | "EXISTS"
    | "RECENT"
    | "EXPUNGE"
    | "FETCH"
    | "SEARCH"
    | "LIST"
    | "LSUB"
    | "STATUS"
    | "FLAGS"
    | "BYE"
    | "CAPABILITY";
  data: UntaggedResponseData;
}

// Helper types for parsing
export interface ParseContext {
  input: string;
  position: number;
  length: number;
}

export interface ParseResult<T> {
  success: boolean;
  value?: T;
  error?: string;
  consumed: number;
}
