import sodium from "libsodium-wrappers";
import { Server } from "mock-socket";
import { parse as parseUrl } from "url";
import { interpret } from "xstate";
import { createSyncMachine } from "./createSyncMachine";

const url = "wss://www.example.com";
const docId = "6e46c006-5541-11ec-bf63-0242ac130002";
let mockServer: Server;

beforeEach(async () => {
  await sodium.ready;
  mockServer = new Server(`${url}/${docId}`);
});

afterEach((done) => {
  mockServer.stop(() => {
    done();
  });
});

test("should start with connecting", (done) => {
  const syncMachine = createSyncMachine();
  const syncService = interpret(
    syncMachine.withContext({
      ...syncMachine.context,
      documentId: docId,
      websocketHost: url,
      websocketSessionKey: "sessionKey",
      sodium,
    })
  ).onTransition((state) => {
    if (state.matches("connecting")) {
      syncService.stop();
      done();
    }
  });

  syncService.start();
});

test("should connect", (done) => {
  const url = "wss://www.example.com";

  const syncMachine = createSyncMachine();
  const syncService = interpret(
    syncMachine.withContext({
      ...syncMachine.context,
      documentId: docId,
      websocketHost: url,
      websocketSessionKey: "sessionKey",
      sodium,
    })
  ).onTransition((state) => {
    if (state.matches("connected")) {
      syncService.stop();
      done();
    }
  });

  syncService.start();
});

test("should connect and use knownSnapshotId as query param", (done) => {
  const url = "wss://www.example.com";

  const syncMachine = createSyncMachine();
  const syncService = interpret(
    syncMachine.withContext({
      ...syncMachine.context,
      documentId: docId,
      websocketHost: url,
      websocketSessionKey: "mySessionKey",
      sodium,
      loadDocumentParams: {
        mode: "snapshot-and-updates",
        knownSnapshotInfo: {
          snapshotId: "mySnapshotId",
          parentSnapshotProof: "myParentSnapshotProof",
          snapshotCiphertextHash: "mySnapshotCiphertextHash",
        },
      },
    })
  );

  mockServer.on("connection", (socket) => {
    expect(socket.url).toBe(
      `wss://www.example.com/${docId}?sessionKey=mySessionKey&mode=snapshot-and-updates&knownSnapshotId=mySnapshotId`
    );
    syncService.stop();
    done();
  });

  syncService.start();
});

test("should connect and use knownSnapshotId & knownSnapshotUpdateClocks as query param", (done) => {
  const url = "wss://www.example.com";

  const syncMachine = createSyncMachine();
  const updateClocks = {
    publicKeyA: 2,
    publicKeyB: 9999,
  };
  const syncService = interpret(
    syncMachine.withContext({
      ...syncMachine.context,
      documentId: docId,
      websocketHost: url,
      websocketSessionKey: "mySessionKey",
      sodium,
      loadDocumentParams: {
        mode: "snapshot-and-updates",
        knownSnapshotInfo: {
          snapshotId: "mySnapshotId",
          parentSnapshotProof: "myParentSnapshotProof",
          snapshotCiphertextHash: "mySnapshotCiphertextHash",
          updateClocks,
        },
      },
    })
  );

  mockServer.on("connection", (socket) => {
    expect(socket.url).toBe(
      `wss://www.example.com/${docId}?sessionKey=mySessionKey&mode=snapshot-and-updates&knownSnapshotId=mySnapshotId&&knownSnapshotUpdateClocks=%7B%22publicKeyA%22%3A2%2C%22publicKeyB%22%3A9999%7D`
    );

    const urlParts = parseUrl(socket.url, true);
    const knownSnapshotUpdateClocks = JSON.parse(
      decodeURIComponent(urlParts.query.knownSnapshotUpdateClocks as string)
    );

    expect(knownSnapshotUpdateClocks).toEqual(updateClocks);
    syncService.stop();
    done();
  });

  syncService.start();
});
