import { parseCommand } from "../../src/server/lib/imap/parsers";

describe("IMAP parsers", () => {
  const STORE_COMMAND = "1.1 UID STORE 1 +FLAGS.SILENT (\\Seen)";

  it(`should parse "${STORE_COMMAND}"`, () => {
    const result = parseCommand(STORE_COMMAND);
    expect(result.success).toBe(true);
    expect(result.value?.tag).toBe("1.1");
    expect(result.value?.request.type).toBe("UID");
    expect(result.consumed).toBe(37);

    if (result.value?.request.type !== "UID") {
      throw new Error("Expected UID request type");
    }

    const uidRequest = result.value.request;
    expect(uidRequest.data.command).toBe("STORE");

    if (uidRequest.data.request.type !== "STORE") {
      throw new Error("Expected STORE request type");
    }

    const storeRequest = uidRequest.data.request;
    expect(storeRequest.data.operation).toBe("+FLAGS.SILENT");
    expect(storeRequest.data.flags).toEqual(["\\Seen"]);
    expect(storeRequest.data.silent).toBe(true);
  });

  it("should parse FETCH command with range", () => {
    const FETCH_COMMAND = "2.1 FETCH 1:15 (FLAGS ENVELOPE)";
    const result = parseCommand(FETCH_COMMAND);
    expect(result.success).toBe(true);
    expect(result.value?.tag).toBe("2.1");
    expect(result.value?.request.type).toBe("FETCH");

    if (result.value?.request.type !== "FETCH") {
      throw new Error("Expected FETCH request type");
    }

    const fetchRequest = result.value.request;
    expect(fetchRequest.data.sequenceSet.ranges[0].start).toBe(1);
    expect(fetchRequest.data.sequenceSet.ranges[0].end).toBe(15);
  });

  it("should parse UID SEARCH command with comma separated UIDs", () => {
    const SEARCH_COMMAND = "3.1 UID SEARCH 1,577,5084,9591";
    const result = parseCommand(SEARCH_COMMAND);
    expect(result.success).toBe(true);
    expect(result.value?.tag).toBe("3.1");
    expect(result.value?.request.type).toBe("UID");
    if (result.value?.request.type !== "UID") {
      throw new Error("Expected UID request type");
    }
    const searchCommand = result.value?.request.data;
    expect(searchCommand.request.type).toBe("SEARCH");
    if (searchCommand.request.type !== "SEARCH") {
      throw new Error("Expected SEARCH request type");
    }
    const searchRequest = searchCommand.request;
    const criterion = searchRequest.data.criteria[0];
    expect(criterion.type).toBe("UID");
    if (criterion.type !== "UID") {
      throw new Error("Expected UID criterion type");
    }
    expect(criterion.sequenceSet).toEqual({
      ranges: [{ start: 1 }, { start: 577 }, { start: 5084 }, { start: 9591 }],
      type: "sequence"
    });
  });

  it("should parse UID SEARCH command with UID range and additional UID label", () => {
    const SEARCH_COMMAND = "4.1 UID SEARCH UID 5091:*";
    const result = parseCommand(SEARCH_COMMAND);
    expect(result.success).toBe(true);
    expect(result.value?.tag).toBe("4.1");
    expect(result.value?.request.type).toBe("UID");
    if (result.value?.request.type !== "UID") {
      throw new Error("Expected UID request type");
    }
    const searchCommand = result.value?.request.data;
    expect(searchCommand.request.type).toBe("SEARCH");
    if (searchCommand.request.type !== "SEARCH") {
      throw new Error("Expected SEARCH request type");
    }
    const searchRequest = searchCommand.request;
    const criterion = searchRequest.data.criteria[0];
    expect(criterion.type).toBe("UID");
    if (criterion.type !== "UID") {
      throw new Error("Expected UID criterion type");
    }
    expect(criterion.sequenceSet).toEqual({
      ranges: [{ start: 5091, end: Number.MAX_SAFE_INTEGER }],
      type: "sequence"
    });
  });

  it("should parse FETCH command with wildcard (*)", () => {
    const FETCH_COMMAND = "5.1 FETCH 1:* (FLAGS)";
    const result = parseCommand(FETCH_COMMAND);
    expect(result.success).toBe(true);
    expect(result.value?.tag).toBe("5.1");
    expect(result.value?.request.type).toBe("FETCH");

    if (result.value?.request.type !== "FETCH") {
      throw new Error("Expected FETCH request type");
    }

    const fetchRequest = result.value.request;
    expect(fetchRequest.data.sequenceSet.ranges[0].start).toBe(1);
    // '*' is represented as Number.MAX_SAFE_INTEGER
    expect(fetchRequest.data.sequenceSet.ranges[0].end).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("should parse STORE command with wildcard range", () => {
    const STORE_COMMAND = "6.1 STORE 1:* +FLAGS (\\Seen)";
    const result = parseCommand(STORE_COMMAND);
    expect(result.success).toBe(true);
    expect(result.value?.tag).toBe("6.1");
    expect(result.value?.request.type).toBe("STORE");

    if (result.value?.request.type !== "STORE") {
      throw new Error("Expected STORE request type");
    }

    const storeRequest = result.value.request;
    expect(storeRequest.data.sequenceSet.ranges[0].start).toBe(1);
    expect(storeRequest.data.sequenceSet.ranges[0].end).toBe(Number.MAX_SAFE_INTEGER);
  });
});
