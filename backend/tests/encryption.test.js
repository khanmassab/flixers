process.env.REQUIRE_ENCRYPTION = "true";

const request = require("supertest");

const {
  app,
  rooms,
  ensureRoom,
  handleMessage,
  issueSessionToken,
} = require("../server");

const authHeader = (name = "Alice", sub = "user-1") => ({
  Authorization: `Bearer ${issueSessionToken({ sub, name })}`,
});

describe("encryption flow", () => {
  afterEach(() => {
    rooms.clear();
  });

  test("creates room with requested encryption flag", async () => {
    const res = await request(app)
      .post("/rooms")
      .set(authHeader())
      .send({ encryptionRequired: false });

    expect(res.status).toBe(200);
    expect(res.body.encryptionRequired).toBe(false);

    const room = rooms.get(res.body.roomId);
    expect(room).toBeDefined();
    expect(room.encryptionRequired).toBe(false);
  });

  test("blocks plaintext chat when encryption is required", () => {
    const roomId = "room-block";
    const room = ensureRoom(roomId, { encryptionRequired: true });
    const sent = [];
    const sender = { name: "Alice", socket: { readyState: 1, send: jest.fn() } };
    const receiver = {
      name: "Bob",
      socket: { readyState: 1, send: (data) => sent.push(data) },
    };
    room.clients.add(sender);
    room.clients.add(receiver);

    handleMessage(roomId, sender, { type: "chat", text: "hi" });

    expect(sent).toHaveLength(0);
  });

  test("blocks plaintext state when encryption is required", () => {
    const roomId = "room-state-block";
    const room = ensureRoom(roomId, { encryptionRequired: true });
    const sent = [];
    const sender = { name: "Alice", socket: { readyState: 1, send: jest.fn() } };
    const receiver = {
      name: "Bob",
      socket: { readyState: 1, send: (data) => sent.push(data) },
    };
    room.clients.add(sender);
    room.clients.add(receiver);

    handleMessage(roomId, sender, { type: "state", payload: { doc: 1 } });

    expect(sent).toHaveLength(0);
  });

  test("allows plaintext chat when encryption is not required", () => {
    const roomId = "room-plain";
    const room = ensureRoom(roomId, { encryptionRequired: false });
    const sent = [];
    const sender = { name: "Alice", socket: { readyState: 1, send: jest.fn() } };
    const receiver = {
      name: "Bob",
      socket: {
        readyState: 1,
        send: (data) => sent.push(JSON.parse(data)),
      },
    };
    room.clients.add(sender);
    room.clients.add(receiver);

    handleMessage(roomId, sender, { type: "chat", text: "hello" });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "chat",
      text: "hello",
      from: "Alice",
    });
  });

  test("relays key exchange to other clients", () => {
    const roomId = "room-keys";
    const room = ensureRoom(roomId, { encryptionRequired: true });
    const sent = [];
    const sender = { name: "Alice", socket: { readyState: 1, send: jest.fn() } };
    const receiver = {
      name: "Bob",
      socket: {
        readyState: 1,
        send: (data) => sent.push(JSON.parse(data)),
      },
    };
    room.clients.add(sender);
    room.clients.add(receiver);

    handleMessage(roomId, sender, {
      type: "key-exchange",
      publicKey: "pub123",
      curve: "P-256",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "key-exchange",
      publicKey: "pub123",
      curve: "P-256",
      from: "Alice",
    });
  });

  test("rebroadcasts encrypted payloads", () => {
    const roomId = "room-encrypted";
    const room = ensureRoom(roomId, { encryptionRequired: true });
    const sent = [];
    const sender = { name: "Alice", socket: { readyState: 1, send: jest.fn() } };
    const receiver = {
      name: "Bob",
      socket: {
        readyState: 1,
        send: (data) => sent.push(JSON.parse(data)),
      },
    };
    room.clients.add(sender);
    room.clients.add(receiver);

    handleMessage(roomId, sender, {
      type: "encrypted",
      ciphertext: "abc",
      iv: "def",
      alg: "aes-256-gcm",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "encrypted",
      ciphertext: "abc",
      iv: "def",
      alg: "aes-256-gcm",
      from: "Alice",
    });
    expect(typeof sent[0].ts).toBe("number");
  });

  test("allows episode-changed broadcast even when encryption is required", () => {
    const roomId = "room-episode";
    const room = ensureRoom(roomId, { encryptionRequired: true });
    const sent = [];
    const sender = { name: "Alice", socket: { readyState: 1, send: jest.fn() } };
    const receiver = {
      name: "Bob",
      socket: {
        readyState: 1,
        send: (data) => sent.push(JSON.parse(data)),
      },
    };
    room.clients.add(sender);
    room.clients.add(receiver);

    handleMessage(roomId, sender, {
      type: "episode-changed",
      url: "https://www.netflix.com/watch/123456",
      ts: 123,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "episode-changed",
      url: "https://www.netflix.com/watch/123456",
      from: "Alice",
      ts: 123,
    });
  });
});
