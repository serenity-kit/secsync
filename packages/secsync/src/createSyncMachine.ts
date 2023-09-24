import type { KeyPair } from "libsodium-wrappers";
import {
  AnyActorRef,
  assign,
  createMachine,
  forwardTo,
  sendTo,
  spawn,
} from "xstate";
import { hash } from "./crypto/hash";
import { messageTypes } from "./ephemeralMessage/createEphemeralMessage";
import { createEphemeralSession } from "./ephemeralMessage/createEphemeralSession";
import { parseEphemeralMessage } from "./ephemeralMessage/parseEphemeralMessage";
import { verifyAndDecryptEphemeralMessage } from "./ephemeralMessage/verifyAndDecryptEphemeralMessage";
import { createInitialSnapshot } from "./snapshot/createInitialSnapshot";
import { createSnapshot } from "./snapshot/createSnapshot";
import { isValidAncestorSnapshot } from "./snapshot/isValidAncestorSnapshot";
import { parseSnapshot } from "./snapshot/parseSnapshot";
import { verifyAndDecryptSnapshot } from "./snapshot/verifyAndDecryptSnapshot";
import {
  EphemeralMessage,
  EphemeralMessagesSession,
  OnDocumentUpdatedEventType,
  ParentSnapshotProofInfo,
  Snapshot,
  SnapshotInfoWithUpdateClocks,
  SnapshotPublicData,
  SyncMachineConfig,
  Update,
} from "./types";
import { createUpdate } from "./update/createUpdate";
import { parseUpdate } from "./update/parseUpdate";
import { verifyAndDecryptUpdate } from "./update/verifyAndDecryptUpdate";
import { updateUpdateClocksEntry } from "./utils/updateUpdateClocksEntry";
import { websocketService } from "./utils/websocketService";

// The sync machine is responsible for syncing the document with the server.
// Specifically it is responsible for:
// - sending snapshots
// - sending updates
// - sending ephemeral messages
// - receiving snapshots
// - receiving updates
// - receiving ephemeral messages
//
// In general the first thing that happens is that a websocket connection is established.
// Once that's done the latest snapshot including it's related updates should be received.
//
// In order to process incoming and outgoing changes the sync machine uses three queues:
// - _incomingQueue: contains all incoming messages from the server
// - _customMessageQueue: contains all custom incoming messages from the server
// - _pendingChangesQueue: contains all outgoing messages that are not yet sent to the server
//
// How Queue processing works
// -------------------------
// 1. first handle all incoming custom messages
// 2. first handle all incoming message
// 3. then handle all pending updates
// Background: There might be a new snapshot and this way we avoid retries
//
// WebSockets reconnection logic:
// During the state connecting the sync machine will try to reconnect to the server.
// If no connection can be established after 5 seconds it will trigger a retry after a delay.
// The delay is based on the number of retries that have already been done using an exponential
// formula: (100 * 1.8 ** websocketRetries).
// The websocketRetries is capped at 13 so that the delay doesn't get too large.
//
// Handling outgoing messages
// -------------------------
// Once a change is added and the `_pendingChangesQueue` is processed it will collect all changes
// and depending on `shouldSendSnapshot` either send a snapshot or an update.
// In case a snapshot is sent `_pendingChangesQueue` is cleared and the `_snapshotInFlight` set to the snapshot ID.
// In case an update is sent the changes will be added to the `_updatesInFlight` and the `_updatesLocalClock` increased by one.
//
// If a snapshot saved event is received
// - it is added to the `_snapshotInfosWithUpdateClocks`
// - the `_snapshotInFlight` is cleared.
// Queue processing for sending messages is resumed.
//
// If an update saved event is received
// - the `updateClocks` in the related snapshot are updated for the current client
// - the update removed from the `_updatesInFlight` removed
//
// IF a snapshot failed to save
// - the snapshot and changes that came with the response are applied and another snapshot is created and sent. If there is a new snapshot and it has been received in the meantime
// the snapshot is ignored. If there are new updates and they already have been applied they
// are ignored as well.
//
// If an update failed to save
// - check if the update is in the `_updatesInFlight` - only if it's there a retry is necessary
// since we know it was not handled by a new snapshot or update
// - set the `_updatesLocalClock` to the `updateClocks` the active snapshot for the current client
// - all the changes from this failed and later updates plus the new pendingChanges are taken and a new update is created and
// sent with the clock set to the latest confirmed clock + 1
//
// When loading the initial document it's important to make sure these variables are correctly set:
// - `_updatesLocalClock` (same as `updateClocks` for the current Client in the latest snapshot)
// - `_snapshotInfosWithUpdateClocks`

// Otherwise you might try to send an update that the server will reject.

type UpdateInFlight = {
  snapshotId: string;
  clock: number;
  changes: any[];
};

export type DocumentDecryptionState =
  | "pending"
  | "failed"
  | "partial"
  | "complete";

type ProcessQueueData = {
  handledQueue: "customMessage" | "incoming" | "pending" | "none";
  snapshotInFlight: SnapshotInfoWithUpdateClocks | null;
  snapshotInfosWithUpdateClocks: SnapshotInfoWithUpdateClocks[];
  updatesLocalClock: number;
  updatesInFlight: UpdateInFlight[];
  pendingChangesQueue: any[];
  ephemeralMessageReceivingErrors: Error[];
  documentDecryptionState: DocumentDecryptionState;
  ephemeralMessagesSession: EphemeralMessagesSession | null;
  snapshotAndUpdateErrors: Error[];
};

export type InternalContextReset = {
  _incomingQueue: any[];
  _customMessageQueue: any[];
  _snapshotInFlight: SnapshotInfoWithUpdateClocks | null;
  _updatesInFlight: UpdateInFlight[];
  _updatesLocalClock: number;
  _documentDecryptionState: DocumentDecryptionState;
  _ephemeralMessagesSession: EphemeralMessagesSession | null;
};

export type Context = SyncMachineConfig &
  InternalContextReset & {
    _websocketRetries: number;
    _websocketActor?: AnyActorRef;
    _websocketShouldReconnect: boolean;
    _pendingChangesQueue: any[];
    _snapshotInfosWithUpdateClocks: SnapshotInfoWithUpdateClocks[];
    _snapshotAndUpdateErrors: Error[];
    _ephemeralMessageReceivingErrors: Error[];
    _ephemeralMessageAuthoringErrors: Error[];
    logging: SyncMachineConfig["logging"];
  };

const disconnectionContextReset: InternalContextReset = {
  _incomingQueue: [],
  _customMessageQueue: [],
  _snapshotInFlight: null,
  _updatesInFlight: [],
  _updatesLocalClock: -1,
  _documentDecryptionState: "pending",
  _ephemeralMessagesSession: null,
};

export const createSyncMachine = () =>
  /** @xstate-layout N4IgpgJg5mDOIC5SwJ4DsDGBZAhhgFgJZpgDEAygKIByAIgNoAMAuoqAA4D2shALoZzRsQAD0QBGcQE4A7ADpxMgKwA2JQBYlAJnEAOTeoA0IFIgC0i9XPU29M9Vq0rdMlSoC+746ky4CxMgBBWloAfUoABQAJSixKACVAgBlQgFUI2kCAFUomViQQLh5+QWExBEkleUZHGRd1XS1GRhljUwqGqQV9RgBmFXVewd1erU9vdGw8IhJSAHVKACFyAHkAYQBpSizQ2gBJcjWV6mpKNZyGFmEivgEhAvKqtsRR3WslPS0pVQcNdRlxiAfFN-LN9odjqdznlrtxbqUHogniZEFoZPIpCpHEpGFIWiopNJAcC-DMyAAxQJ7JKUMJreKUbJ7agAcXC0ViCWSaQy2VyVwKNxK91A7TMjnEckxvSUMt6jF0IxkUmM5ScVQU4iqvVGdUcvWJk1JATkGEEJAw-DQUHmS1Wm22oSOJzOFxhgrhwrKEjUSgUMj6vT0NXU4i0RhRCH6VhsVRUYZUjBxScNvmmJrNaAtVptwTpUUCrMo5HdHE9d29FXRjClg1cKnlunEQdakYsjWs6N0Sik6lkLT6qZBZNN5rAluIUDkAHccLdrbblustjsGVl4gBNUuFcsI0DlSSjOQB3u9THOD7-Z5R-Tdbu9-7qBtaKpD40kUdZ8e8SCL+0r3Z1lSOJqB2agVh2ckVlSOhtyFCtEQQJomjkM8RikF8pBGf4lGvcRGD7VCMMcKRejqXEXzfdMP0zbNfwWJcHR2GDAlSLIohWeI9gALVpODdxFUQJEJP0tVxVQWj7cQ8LPLRrFkj4tB1ew0So0EwE-OiID-ZdHVoICQJ2BJ4k4-jigQ-dURqSURiqfQDCqPo8IMKUtEVHUviUD4ajUkdaO-SA5EICAABsyAY-9HTzUIshWUJmSOLBmTZABFVJKHSsz4UEtVmjkNRFSURUlJcfpejwpMVGPIYXzUL5D18jMx0tQLgrCnSmNCaLYqdVJyFirBQjichyECFlKFCNKMv5fIy3MvchKQvKCu7YrelKhs8K1OTbNcF91D6LyAS8IEjWojT-JaiAgtCoIQidAsixLAU5uyys3L9FaPixOVvrwpxJUYeMagI5tdEJRqaOan9rvYAAnTgMDgHhrRSgBXMAMdgUgIEEDTiAAN04ABrDT4cR5H0cxuAsq9RD8I1BxvjPeNm2bFVI0PSU-gJGpXFlA0TpJc7NIC2GEaR2AUagKmsdIMA4YRuG5HYEKcF4AAzTg4YAWxViXKYxrHaYsxbpC1BQcW+RN7EJf6cTkKo9GfLzSI8IWzvU0Wrv1impcnWW4A6gDurihKViS1lJvSzKXp3eacsQFR7DkRoNF0BsAybaTObBx3ZH+OoAyTAjIYu6HAvJyXpcD7GIt0nZQ96-qI6G4tRvG6PppNhbygGGt0UTJMyPjIrcM5gi5L7HtmiDeUhndiY0y9y6Yd96uA6NoPorWR7xue2b47e+mwzktEsKTL4CKwlQZKU-KekYcQ1G+IrF9O5e-Ir66CHHYnJ3JNrLA2swCBz2D+HWdc7QNy6vdHq4dI6pRjjNWECdKziEfHIBUQZCSaHWlIXsW0exyHDJoN+4ZnaCyXsOJqX4fa-wwP-a0gC4bALhqAre4CwCQODlFOBcU1h9QGm3EaY0JpTVjofeCvcJA2BrIGGQOgnxYnBhVBsCgmZNiBjIRQKYPaf1oVpU0+A-4AKASAsBEDsY7z3sWHuicKg9isPhNE-xdCHXjK2doGDQz5VIsqcMQZkLqDLt7NeDCmFQBYWwjh1MuE8JELAXg6sNI4A1j+OGAAKRgABKUgwsV7f2MaY5h5j2GWO4bAex6DT7WGKmoRQZEez-QGAob4iiCLiTfqE1egUIlmNYRYzhVjSCJOST+OQaSMnZLyQUr+dDwkmMYQMmJFTIH0HEFIgS6CmiShKjoHUvYn7XkaPIMSTQkzPz7G5UJEBCCwF6dpGxhZ97VMQphEhT4S4HVGLiW+kY6hSmbOGAkkh8JniULc+5jzSDOihFkN5lkEAEisD2SQ-w+jKDUHhVpWd0SEhHm4TQUKHnf1IIixaPYqpXxlIE7QLhdDXh1APAigwbAyBHqMTwJ00CcAgHAYQcyAioOPki-5YonBdGlLKWUColRSB6dDScIq6ZItcL0BQQ9XB9DBd8a8TgWXdhaK4QYOINCKoWZOOQ7DeBwxQMqj0aD6YLxIXiDBCppBGojO0IYbxpCxj7IGoYg59E0Khpa60M45w5hVabco2dNXNG1UGSQerIz9ElNIcMvZ+bKEURarSsaZEIA0NeAkclk5KVDE-XsjgQmhvfOXBZrVbpFocS4raAZXVog5fKbQCp63UMbWEyuBt-aoy3vAR1orFrOHkI0J+7iCINiKv9M8fjwYjEVGGUiVCP5hqbUY-ppTBnlOGZUtt6D+35T1HUdxtac7eINahJ8zZ4xNmCSSx5l7EJDElMqJseoXA-DTe0L4U8qgBnwl8rCoTeWBAwNXH9SLHB5R1EGA6OI3HInaCMKquDMTon6ISHRoSNZzjChAZDi0KF+ixTKU5jQlJrq6ASTd60P2kUhdyoAA */
  createMachine(
    {
      schema: {
        events: {} as
          | { type: "WEBSOCKET_CONNECTED" }
          | { type: "WEBSOCKET_DISCONNECTED" }
          | { type: "WEBSOCKET_DOCUMENT_NOT_FOUND" }
          | { type: "WEBSOCKET_UNAUTHORIZED" }
          | { type: "WEBSOCKET_DOCUMENT_ERROR" }
          | { type: "WEBSOCKET_ADD_TO_INCOMING_QUEUE"; data: any }
          | { type: "WEBSOCKET_ADD_TO_CUSTOM_MESSAGE_QUEUE"; data: any }
          | { type: "WEBSOCKET_RETRY" }
          | { type: "DISCONNECT" }
          | { type: "CONNECT" }
          | { type: "ADD_CHANGES"; data: any[] }
          | {
              type: "ADD_EPHEMERAL_MESSAGE";
              data: any;
              messageType?: keyof typeof messageTypes;
            }
          | {
              type: "SEND_EPHEMERAL_MESSAGE";
              data: any;
              messageType: keyof typeof messageTypes;
              getKey: () => Uint8Array | Promise<Uint8Array>;
            }
          | {
              type: "FAILED_CREATING_EPHEMERAL_MESSAGE";
              error: any;
            }
          | { type: "SEND"; message: any },
        context: {} as Context,
        services: {} as {
          processQueues: { data: ProcessQueueData };
        },
      },
      tsTypes: {} as import("./createSyncMachine.typegen").Typegen0,
      predictableActionArguments: true,
      context: {
        documentId: "",
        signatureKeyPair: {} as KeyPair,
        websocketHost: "",
        websocketSessionKey: "",
        applySnapshot: () => undefined,
        getSnapshotKey: () => Promise.resolve(new Uint8Array()),
        applyChanges: () => undefined,
        getNewSnapshotData: () =>
          Promise.resolve({
            id: "",
            data: "",
            key: new Uint8Array(),
            publicData: {},
          }),
        applyEphemeralMessage: () => undefined,
        shouldSendSnapshot: () => false,
        sodium: {},
        serializeChanges: () => "",
        deserializeChanges: () => [],
        onDocumentUpdated: undefined,
        isValidClient: async () => false,
        logging: "off",
        additionalAuthenticationDataValidations: undefined,
        _snapshotInFlight: null, // it is needed so the the snapshotInFlight can be applied as the activeSnapshot once the server confirmed that it has been saved
        _incomingQueue: [],
        _customMessageQueue: [],
        _pendingChangesQueue: [],
        _snapshotInfosWithUpdateClocks: [],
        _websocketShouldReconnect: false,
        _websocketRetries: 0,
        _updatesInFlight: [], // is needed to collect all changes from updates that haven't been confirmed in case of a disconnect
        _updatesLocalClock: -1,
        _snapshotAndUpdateErrors: [],
        _ephemeralMessageReceivingErrors: [],
        _ephemeralMessageAuthoringErrors: [],
        _ephemeralMessagesSession: null,
        _documentDecryptionState: "pending",
      },
      initial: "connecting",
      on: {
        SEND: {
          actions: forwardTo("websocketActor"),
        },
        ADD_EPHEMERAL_MESSAGE: {
          actions: sendTo("websocketActor", (context, event) => {
            return {
              type: "SEND_EPHEMERAL_MESSAGE",
              data: event.data,
              messageType: event.messageType || "message",
              getKey: async () => {
                const activeSnapshot =
                  context._snapshotInfosWithUpdateClocks[
                    context._snapshotInfosWithUpdateClocks.length - 1
                  ]?.snapshot;
                const key = await context.getSnapshotKey(activeSnapshot);
                return key;
              },
            };
          }),
        },
        WEBSOCKET_DISCONNECTED: { target: "disconnected" },
        DISCONNECT: { target: "disconnected" },
        FAILED_CREATING_EPHEMERAL_MESSAGE: {
          actions: ["updateEphemeralMessageAuthoringErrors"],
        },
      },
      states: {
        connecting: {
          initial: "waiting",
          states: {
            retrying: {
              entry: ["increaseWebsocketRetry", "spawnWebsocketActor"],
            },
            waiting: {
              invoke: {
                id: "scheduleRetry",
                src: "scheduleRetry",
              },
              on: {
                WEBSOCKET_RETRY: {
                  target: "retrying",
                },
              },
            },
          },
          on: {
            WEBSOCKET_CONNECTED: {
              target: "connected",
            },
            ADD_CHANGES: {
              actions: ["addToPendingUpdatesQueue"],
            },
          },
        },
        connected: {
          entry: ["resetWebsocketRetries"],
          states: {
            idle: {
              on: {
                WEBSOCKET_ADD_TO_INCOMING_QUEUE: {
                  actions: ["addToIncomingQueue"],
                  target: "processingQueues",
                },
                WEBSOCKET_ADD_TO_CUSTOM_MESSAGE_QUEUE: {
                  actions: ["addToCustomMessageQueue"],
                  target: "processingQueues",
                },
                ADD_CHANGES: {
                  actions: ["addToPendingUpdatesQueue"],
                  target: "processingQueues",
                },
              },
            },
            processingQueues: {
              on: {
                WEBSOCKET_ADD_TO_INCOMING_QUEUE: {
                  actions: ["addToIncomingQueue"],
                },
                WEBSOCKET_ADD_TO_CUSTOM_MESSAGE_QUEUE: {
                  actions: ["addToCustomMessageQueue"],
                },
                ADD_CHANGES: {
                  actions: ["addToPendingUpdatesQueue"],
                },
              },
              invoke: {
                id: "processQueues",
                src: "processQueues",
                onDone: {
                  actions: ["removeOldestItemFromQueueAndUpdateContext"],
                  target: "checkingForMoreQueueItems",
                },
                onError: {
                  actions: ["storeErrorInSnapshotAndUpdateErrors"],
                  target: "#syncMachine.failed",
                },
              },
            },

            checkingForMoreQueueItems: {
              on: {
                WEBSOCKET_ADD_TO_INCOMING_QUEUE: {
                  actions: ["addToIncomingQueue"],
                },
                WEBSOCKET_ADD_TO_CUSTOM_MESSAGE_QUEUE: {
                  actions: ["addToCustomMessageQueue"],
                },
                ADD_CHANGES: {
                  actions: ["addToPendingUpdatesQueue"],
                },
              },
              after: {
                // move to the next tick so that the queue is no causing an endless loop of processing
                0: [
                  {
                    target: "processingQueues",
                    cond: "hasMoreItemsInQueues",
                  },
                  { target: "idle" },
                ],
              },
            },
          },
          on: {
            WEBSOCKET_DOCUMENT_NOT_FOUND: { target: "noAccess" },
            WEBSOCKET_UNAUTHORIZED: { target: "noAccess" },
            WEBSOCKET_DOCUMENT_ERROR: { target: "failed" },
          },

          initial: "idle",
        },

        disconnected: {
          entry: ["resetContext", "stopWebsocketActor"],
          always: {
            target: "connecting",
            cond: "shouldReconnect",
          },
          on: {
            ADD_CHANGES: {
              actions: ["addToPendingUpdatesQueue"],
            },
            CONNECT: {
              target: "connecting",
            },
          },
        },
        noAccess: {
          entry: ["stopWebsocketActor"],
        },
        failed: {
          entry: ["stopWebsocketActor"],
        },
      },
      id: "syncMachine",
    },
    {
      actions: {
        resetWebsocketRetries: assign({
          _websocketRetries: 0,
        }),
        increaseWebsocketRetry: assign((context) => {
          // limit it to 13 to prevent too long apart retries
          if (context._websocketRetries < 13) {
            return { _websocketRetries: context._websocketRetries + 1 };
          }
          return { _websocketRetries: context._websocketRetries };
        }),
        spawnWebsocketActor: assign((context) => {
          // the counter in there is only the initial counter and actually
          // increased with ever ephemeral message sent inside "websocketActor"
          const ephemeralMessagesSession = createEphemeralSession(
            context.sodium
          );
          return {
            _ephemeralMessagesSession: ephemeralMessagesSession,
            _websocketActor: spawn(
              websocketService(context, ephemeralMessagesSession),
              "websocketActor"
            ),
          };
        }),
        stopWebsocketActor: assign((context) => {
          if (context._websocketActor?.stop) {
            context._websocketActor?.stop();
          }
          return {
            _websocketActor: undefined,
          };
        }),
        resetContext: assign((context, event) => {
          let unconfirmedChanges = context._updatesInFlight.reduce(
            (accumulator, updateInFlight) => {
              return [...accumulator, ...updateInFlight.changes];
            },
            []
          );
          unconfirmedChanges = [
            ...unconfirmedChanges,
            ...context._pendingChangesQueue,
          ];
          return {
            // reset the context and make sure there are no stale references
            // using JSON.parse(JSON.stringify()) to make sure we have a clean copy
            ...JSON.parse(JSON.stringify(disconnectionContextReset)),
            // only take the last one since this will be used to re-connect
            // TODO on reconnect verify this is correct and test it!
            // _snapshotInfosWithUpdateClocks: [
            //   context._snapshotInfosWithUpdateClocks[
            //     context._snapshotInfosWithUpdateClocks.length - 1
            //   ],
            // ],
            _snapshotInfosWithUpdateClocks: [],
            // collected all unconfirmed changes to avoid them getting lost
            _pendingChangesQueue: unconfirmedChanges,
            _websocketShouldReconnect: event.type !== "DISCONNECT",
          };
        }),
        addToIncomingQueue: assign((context, event) => {
          return {
            _incomingQueue: [...context._incomingQueue, event.data],
          };
        }),
        addToCustomMessageQueue: assign((context, event) => {
          return {
            _customMessageQueue: [...context._customMessageQueue, event.data],
          };
        }),
        addToPendingUpdatesQueue: assign((context, event) => {
          if (context.logging === "debug") {
            console.debug("addToPendingUpdatesQueue", event.data);
          }
          return {
            _pendingChangesQueue: [
              ...context._pendingChangesQueue,
              ...event.data,
            ],
          };
        }),
        removeOldestItemFromQueueAndUpdateContext: assign((context, event) => {
          if (event.data.handledQueue === "incoming") {
            return {
              _incomingQueue: context._incomingQueue.slice(1),
              _pendingChangesQueue: event.data.pendingChangesQueue,
              _snapshotInfosWithUpdateClocks:
                event.data.snapshotInfosWithUpdateClocks,
              _snapshotInFlight: event.data.snapshotInFlight,
              _updatesLocalClock: event.data.updatesLocalClock,
              _updatesInFlight: event.data.updatesInFlight,
              _ephemeralMessageReceivingErrors:
                event.data.ephemeralMessageReceivingErrors,
              _documentDecryptionState: event.data.documentDecryptionState,
              _ephemeralMessagesSession: event.data.ephemeralMessagesSession,
              _snapshotAndUpdateErrors: event.data.snapshotAndUpdateErrors,
            };
          } else if (event.data.handledQueue === "customMessage") {
            return {
              _customMessageQueue: context._customMessageQueue.slice(1),
              _pendingChangesQueue: event.data.pendingChangesQueue,
              _snapshotInfosWithUpdateClocks:
                event.data.snapshotInfosWithUpdateClocks,
              _snapshotInFlight: event.data.snapshotInFlight,
              _updatesLocalClock: event.data.updatesLocalClock,
              _updatesInFlight: event.data.updatesInFlight,
              _ephemeralMessageReceivingErrors:
                event.data.ephemeralMessageReceivingErrors,
              _ephemeralMessagesSession: event.data.ephemeralMessagesSession,
              _documentDecryptionState: event.data.documentDecryptionState,
              _snapshotAndUpdateErrors: event.data.snapshotAndUpdateErrors,
            };
          } else if (event.data.handledQueue === "pending") {
            return {
              _pendingChangesQueue: event.data.pendingChangesQueue,
              _snapshotInfosWithUpdateClocks:
                event.data.snapshotInfosWithUpdateClocks,
              _snapshotInFlight: event.data.snapshotInFlight,
              _updatesLocalClock: event.data.updatesLocalClock,
              _updatesInFlight: event.data.updatesInFlight,
              _ephemeralMessageReceivingErrors:
                event.data.ephemeralMessageReceivingErrors,
              _ephemeralMessagesSession: event.data.ephemeralMessagesSession,
              _documentDecryptionState: event.data.documentDecryptionState,
              _snapshotAndUpdateErrors: event.data.snapshotAndUpdateErrors,
            };
          } else if (event.data.handledQueue === "none") {
            return {};
          } else {
            throw new Error("Unhandled queue");
          }
        }),
        // @ts-expect-error can't type the onError differently than onDone
        storeErrorInSnapshotAndUpdateErrors: assign((context, event) => {
          return {
            _documentDecryptionState:
              // @ts-expect-error documentDecryptionState is dynamically added to the error event
              event.data?.documentDecryptionState ||
              context._documentDecryptionState,
            _snapshotAndUpdateErrors: [
              event.data,
              ...context._snapshotAndUpdateErrors,
            ],
          };
        }),
        updateEphemeralMessageAuthoringErrors: assign((context, event) => {
          return {
            _ephemeralMessageAuthoringErrors: [
              event.error,
              ...context._ephemeralMessageAuthoringErrors,
            ].slice(0, 20), // avoid a memory leak by storing max 20 errors
          };
        }),
      },
      services: {
        scheduleRetry: (context) => (callback) => {
          const delay = 100 * 1.8 ** context._websocketRetries;
          if (context.logging === "debug") {
            console.debug(
              `schedule websocket connection #${context._websocketRetries} in `,
              delay
            );
          }
          setTimeout(() => {
            callback("WEBSOCKET_RETRY");
            // calculating slow exponential back-off
          }, delay);
        },
        processQueues: (context, event) => async (send) => {
          if (context.logging === "debug") {
            console.debug("processQueues event", event);
            console.debug("_incomingQueue", context._incomingQueue.length);
            console.debug(
              "_customMessageQueue",
              context._customMessageQueue.length
            );
            console.debug(
              "_pendingChangesQueue",
              context._pendingChangesQueue.length
            );
          }

          let handledQueue: "customMessage" | "incoming" | "pending" | "none" =
            "none";
          let snapshotInfosWithUpdateClocks =
            context._snapshotInfosWithUpdateClocks;
          let activeSnapshot: Snapshot | null =
            snapshotInfosWithUpdateClocks[
              snapshotInfosWithUpdateClocks.length - 1
            ]?.snapshot || null;
          let snapshotInFlight = context._snapshotInFlight;
          let updatesLocalClock = context._updatesLocalClock;
          let updatesInFlight = context._updatesInFlight;
          let pendingChangesQueue = context._pendingChangesQueue;
          let documentDecryptionState = context._documentDecryptionState;
          let ephemeralMessagesSession = context._ephemeralMessagesSession;
          let snapshotAndUpdateErrors = context._snapshotAndUpdateErrors;
          let errorCausingDocumentToFail: Error | null = null;

          let ephemeralMessageReceivingErrors =
            context._ephemeralMessageReceivingErrors;

          const invokeOnDocumentUpdated = (
            type: OnDocumentUpdatedEventType
          ) => {
            try {
              if (context.onDocumentUpdated) {
                const snapshotInfosWithUpdateClocksEntry =
                  snapshotInfosWithUpdateClocks[
                    snapshotInfosWithUpdateClocks.length - 1
                  ] || null;

                context.onDocumentUpdated({
                  type,
                  knownSnapshotInfo: {
                    snapshotId:
                      snapshotInfosWithUpdateClocksEntry.snapshot.publicData
                        .snapshotId,
                    parentSnapshotProof:
                      snapshotInfosWithUpdateClocksEntry.snapshot.publicData
                        .parentSnapshotProof,
                    snapshotCiphertextHash: hash(
                      snapshotInfosWithUpdateClocksEntry.snapshot.ciphertext,
                      context.sodium
                    ),
                    updateClocks:
                      snapshotInfosWithUpdateClocksEntry.updateClocks,
                  },
                });
              }
            } catch (err) {
              // logging anyway since this is a error by the developer implementing it
              console.error(err);
            }
          };

          try {
            const createAndSendSnapshot = async () => {
              try {
                const snapshotData = await context.getNewSnapshotData();
                if (context.logging === "debug") {
                  console.log("createAndSendSnapshot", snapshotData);
                }

                // no snapshot exists so far
                if (snapshotInfosWithUpdateClocks.length === 0) {
                  const publicData: SnapshotPublicData = {
                    ...snapshotData.publicData,
                    snapshotId: snapshotData.id,
                    docId: context.documentId,
                    pubKey: context.sodium.to_base64(
                      context.signatureKeyPair.publicKey
                    ),
                    parentSnapshotId: "",
                    parentSnapshotUpdateClocks: {},
                  };
                  const snapshot = createInitialSnapshot(
                    snapshotData.data,
                    publicData,
                    snapshotData.key,
                    context.signatureKeyPair,
                    context.sodium
                  );

                  snapshotInFlight = {
                    updateClocks: {},
                    snapshot,
                  };
                  pendingChangesQueue = [];

                  send({
                    type: "SEND",
                    message: JSON.stringify({
                      ...snapshot,
                      // Note: send a faulty message to test the error handling
                      // ciphertext: "lala",
                      additionalServerData: snapshotData.additionalServerData,
                    }),
                  });
                } else {
                  const currentClientPublicKey = context.sodium.to_base64(
                    context.signatureKeyPair.publicKey
                  );
                  const publicData: SnapshotPublicData = {
                    ...snapshotData.publicData,
                    snapshotId: snapshotData.id,
                    docId: context.documentId,
                    pubKey: currentClientPublicKey,
                    parentSnapshotId: activeSnapshot.publicData.snapshotId,
                    parentSnapshotUpdateClocks:
                      snapshotInfosWithUpdateClocks.find(
                        (entry) =>
                          entry.snapshot.publicData.snapshotId ===
                          activeSnapshot.publicData.snapshotId
                      ).updateClocks || {},
                  };
                  const snapshot = createSnapshot(
                    snapshotData.data,
                    publicData,
                    snapshotData.key,
                    context.signatureKeyPair,
                    activeSnapshot.ciphertext,
                    activeSnapshot.publicData.parentSnapshotProof,
                    context.sodium
                  );

                  snapshotInFlight = {
                    updateClocks: {},
                    snapshot,
                  };
                  pendingChangesQueue = [];

                  send({
                    type: "SEND",
                    message: JSON.stringify({
                      ...snapshot,
                      // Note: send a faulty message to test the error handling
                      // ciphertext: "lala",
                      additionalServerData: snapshotData.additionalServerData,
                    }),
                  });
                }
              } catch (err) {
                if (
                  context.logging === "debug" ||
                  context.logging === "error"
                ) {
                  console.error(err);
                }
                errorCausingDocumentToFail = new Error("SECSYNC_ERROR_401");
              }
            };

            const createAndSendUpdate = async (
              changes: unknown[],
              activeSnapshot: Snapshot,
              clock: number
            ) => {
              try {
                const key = await context.getSnapshotKey(activeSnapshot);
                const refSnapshotId = activeSnapshot.publicData.snapshotId;

                const update = context.serializeChanges(changes);
                updatesLocalClock = clock + 1;

                const publicData = {
                  refSnapshotId,
                  docId: context.documentId,
                  pubKey: context.sodium.to_base64(
                    context.signatureKeyPair.publicKey
                  ),
                };
                const message = createUpdate(
                  update,
                  publicData,
                  key,
                  context.signatureKeyPair,
                  updatesLocalClock,
                  context.sodium
                );

                updatesInFlight.push({
                  snapshotId: activeSnapshot.publicData.snapshotId,
                  clock: updatesLocalClock,
                  changes,
                });
                send({
                  type: "SEND",
                  message: JSON.stringify(message),
                  // Note: send a faulty message to test the error handling
                  // message: JSON.stringify({ ...message, ciphertext: "lala" }),
                });
              } catch (err) {
                if (
                  context.logging === "debug" ||
                  context.logging === "error"
                ) {
                  console.error(err);
                }
                errorCausingDocumentToFail = new Error("SECSYNC_ERROR_501");
              }
            };

            const processSnapshot = async (
              rawSnapshot: Snapshot,
              parentSnapshotProofInfo?: ParentSnapshotProofInfo
            ) => {
              try {
                if (context.logging === "debug") {
                  console.debug("processSnapshot", rawSnapshot);
                }
                let snapshot: Snapshot;
                try {
                  snapshot = parseSnapshot(
                    rawSnapshot,
                    context.additionalAuthenticationDataValidations?.snapshot
                  );
                } catch (err) {
                  snapshotAndUpdateErrors.unshift(
                    new Error("SECSYNC_ERROR_110")
                  );
                  return;
                }

                try {
                  const isValidClient = await context.isValidClient(
                    snapshot.publicData.pubKey
                  );
                  if (!isValidClient) {
                    snapshotAndUpdateErrors.unshift(
                      new Error("SECSYNC_ERROR_114")
                    );
                    return;
                  }
                } catch (err) {
                  if (
                    context.logging === "debug" ||
                    context.logging === "error"
                  ) {
                    console.error(err);
                  }
                  errorCausingDocumentToFail = new Error("SECSYNC_ERROR_104");
                  return;
                }

                let parentSnapshotUpdateClock: number | undefined = undefined;

                const parentSnapshotUpdateClocks =
                  snapshotInfosWithUpdateClocks.find(
                    (entry) =>
                      entry.snapshot.publicData.snapshotId ===
                      activeSnapshot.publicData.snapshotId
                  )?.updateClocks;
                if (parentSnapshotProofInfo && parentSnapshotUpdateClocks) {
                  const currentClientPublicKey = context.sodium.to_base64(
                    context.signatureKeyPair.publicKey
                  );
                  parentSnapshotUpdateClock =
                    parentSnapshotUpdateClocks[currentClientPublicKey];
                }

                let snapshotKey: Uint8Array;
                try {
                  snapshotKey = await context.getSnapshotKey(snapshot);
                } catch (err) {
                  if (
                    context.logging === "debug" ||
                    context.logging === "error"
                  ) {
                    console.error(err);
                  }
                  errorCausingDocumentToFail = new Error("SECSYNC_ERROR_103");
                  return;
                }
                // console.log("processSnapshot key", snapshotKey);
                const decryptedSnapshotResult = verifyAndDecryptSnapshot(
                  snapshot,
                  snapshotKey,
                  context.documentId,
                  context.signatureKeyPair.publicKey,
                  context.sodium,
                  parentSnapshotProofInfo,
                  parentSnapshotUpdateClock
                );

                if (decryptedSnapshotResult.error) {
                  if (
                    decryptedSnapshotResult.error.message ===
                      "SECSYNC_ERROR_100" ||
                    decryptedSnapshotResult.error.message ===
                      "SECSYNC_ERROR_101" ||
                    decryptedSnapshotResult.error.message ===
                      "SECSYNC_ERROR_102"
                  ) {
                    errorCausingDocumentToFail = decryptedSnapshotResult.error;
                  } else {
                    snapshotAndUpdateErrors.unshift(
                      decryptedSnapshotResult.error
                    );
                  }

                  return;
                }

                try {
                  context.applySnapshot(decryptedSnapshotResult.content);
                } catch (err) {
                  if (
                    context.logging === "debug" ||
                    context.logging === "error"
                  ) {
                    console.error(err);
                  }
                  errorCausingDocumentToFail = new Error("SECSYNC_ERROR_105");
                  return;
                }
                // can be inserted in the last position since verifyAndDecryptSnapshot already verified the parent
                snapshotInfosWithUpdateClocks.push({
                  updateClocks: {},
                  snapshot,
                });

                // cleanup old snapshotInfosWithUpdateClocks entries and only keep the last 3 for debugging purposes
                // cleaning them up to avoid a memory leak
                snapshotInfosWithUpdateClocks =
                  snapshotInfosWithUpdateClocks.slice(-3);
                updatesLocalClock = -1;

                // TODO test the callback
                invokeOnDocumentUpdated("snapshot-received");
              } catch (err) {
                if (
                  context.logging === "debug" ||
                  context.logging === "error"
                ) {
                  console.error(err);
                }
                errorCausingDocumentToFail = new Error("SECSYNC_ERROR_100");
              }
            };

            const processUpdates = async (
              rawUpdates: Update[],
              relatedSnapshot: Snapshot
            ) => {
              try {
                let key: Uint8Array;
                try {
                  key = await context.getSnapshotKey(relatedSnapshot);
                } catch (err) {
                  if (
                    context.logging === "debug" ||
                    context.logging === "error"
                  ) {
                    console.error(err);
                  }
                  errorCausingDocumentToFail = new Error("SECSYNC_ERROR_206");
                  return;
                }

                // must be redefined here, since a snapshot from loading a document might have been applied
                // before updates are processed
                const activeSnapshot = relatedSnapshot;

                let changes: unknown[] = [];

                for (let rawUpdate of rawUpdates) {
                  let update: Update;
                  try {
                    update = parseUpdate(
                      rawUpdate,
                      context.additionalAuthenticationDataValidations?.update
                    );
                  } catch (err) {
                    snapshotAndUpdateErrors.unshift(
                      new Error("SECSYNC_ERROR_211")
                    );
                    continue;
                  }

                  try {
                    const isValidClient = await context.isValidClient(
                      update.publicData.pubKey
                    );
                    if (!isValidClient) {
                      snapshotAndUpdateErrors.unshift(
                        new Error("SECSYNC_ERROR_215")
                      );
                      continue;
                    }
                  } catch (err) {
                    if (
                      context.logging === "debug" ||
                      context.logging === "error"
                    ) {
                      console.error(err);
                    }
                    errorCausingDocumentToFail = new Error("SECSYNC_ERROR_205");
                    continue;
                  }

                  const unverifiedCurrentClock =
                    snapshotInfosWithUpdateClocks[
                      snapshotInfosWithUpdateClocks.length - 1
                    ]?.updateClocks[update.publicData.pubKey];
                  const currentClock = Number.isInteger(unverifiedCurrentClock)
                    ? unverifiedCurrentClock
                    : -1;

                  const decryptUpdateResult = verifyAndDecryptUpdate(
                    update,
                    key,
                    activeSnapshot.publicData.snapshotId,
                    currentClock,
                    context.sodium,
                    context.logging
                  );

                  if (decryptUpdateResult.error) {
                    const ignoreErrorList = [
                      "SECSYNC_ERROR_211",
                      "SECSYNC_ERROR_212",
                      "SECSYNC_ERROR_213",
                      "SECSYNC_ERROR_214",
                      "SECSYNC_ERROR_215",
                    ];
                    if (
                      ignoreErrorList.includes(
                        decryptUpdateResult.error.message
                      )
                    ) {
                      snapshotAndUpdateErrors.unshift(
                        decryptUpdateResult.error
                      );
                      continue;
                    } else {
                      errorCausingDocumentToFail = decryptUpdateResult.error;
                      continue;
                    }
                  }

                  const { content, clock } = decryptUpdateResult;

                  snapshotInfosWithUpdateClocks = updateUpdateClocksEntry({
                    snapshotInfosWithUpdateClocks,
                    snapshotId: activeSnapshot.publicData.snapshotId,
                    clientPublicKey: update.publicData.pubKey,
                    newClock: clock,
                  });

                  if (
                    update.publicData.pubKey ===
                    context.sodium.to_base64(context.signatureKeyPair.publicKey)
                  ) {
                    updatesLocalClock = update.publicData.clock;
                  }
                  try {
                    const additionalChanges = context.deserializeChanges(
                      context.sodium.to_string(content)
                    );
                    changes = changes.concat(additionalChanges);
                  } catch (err) {
                    if (
                      context.logging === "debug" ||
                      context.logging === "error"
                    ) {
                      console.error(err);
                    }
                    errorCausingDocumentToFail = new Error("SECSYNC_ERROR_204");
                  }
                }

                try {
                  context.applyChanges(changes);
                } catch (err) {
                  if (
                    context.logging === "debug" ||
                    context.logging === "error"
                  ) {
                    console.error(err);
                  }
                  errorCausingDocumentToFail = new Error("SECSYNC_ERROR_203");
                }

                // TODO test the callback
                invokeOnDocumentUpdated("update-received");
              } catch (err) {
                if (
                  context.logging === "debug" ||
                  context.logging === "error"
                ) {
                  console.error(err);
                }
                errorCausingDocumentToFail = new Error("SECSYNC_ERROR_200");
              }
            };

            if (context._customMessageQueue.length > 0) {
              handledQueue = "customMessage";
              const event = context._customMessageQueue[0];
              if (context.onCustomMessage) {
                await context.onCustomMessage(event);
              }
            } else if (context._incomingQueue.length > 0) {
              handledQueue = "incoming";
              const event = context._incomingQueue[0];
              switch (event.type) {
                case "document":
                  documentDecryptionState = "failed";
                  if (context.knownSnapshotInfo) {
                    const isValid = isValidAncestorSnapshot({
                      knownSnapshotProofEntry: {
                        parentSnapshotProof:
                          context.knownSnapshotInfo.parentSnapshotProof,
                        snapshotCiphertextHash:
                          context.knownSnapshotInfo.snapshotCiphertextHash,
                        snapshotId: context.knownSnapshotInfo.snapshotId,
                      },
                      snapshotProofChain: event.snapshotProofChain,
                      currentSnapshot: event.snapshot,
                      sodium: context.sodium,
                    });
                    if (!isValid) {
                      throw new Error("Invalid ancestor snapshot");
                    }
                  }

                  if (
                    !event.snapshot &&
                    event.updates &&
                    event.updates.length > 0
                  ) {
                    throw new Error("Document has no snapshot but has updates");
                  }
                  if (event.snapshot) {
                    const snapshotAndUpdateErrorsLength =
                      snapshotAndUpdateErrors.length;

                    await processSnapshot(event.snapshot);

                    // if the initial snapshot fails the document can't be loaded
                    if (
                      snapshotAndUpdateErrors.length >
                      snapshotAndUpdateErrorsLength
                    ) {
                      errorCausingDocumentToFail = snapshotAndUpdateErrors[0];
                      // remove the item since it will be added later due errorCausingDocumentToFail being set
                      snapshotAndUpdateErrors.pop();
                    }

                    if (errorCausingDocumentToFail === null) {
                      documentDecryptionState = "partial";

                      if (event.updates) {
                        await processUpdates(event.updates, event.snapshot);
                      }

                      if (
                        snapshotAndUpdateErrors.length >
                        snapshotAndUpdateErrorsLength
                      ) {
                        errorCausingDocumentToFail = snapshotAndUpdateErrors[0];
                        // remove the item since it will be added later due errorCausingDocumentToFail being set
                        snapshotAndUpdateErrors.pop();
                      }

                      if (errorCausingDocumentToFail === null) {
                        documentDecryptionState = "complete";
                      }
                    }
                  } else {
                    documentDecryptionState = "complete";
                  }

                  break;

                case "snapshot":
                  if (context.logging === "debug") {
                    console.log("snapshot", event);
                  }
                  await processSnapshot(
                    event.snapshot,
                    activeSnapshot
                      ? {
                          id: activeSnapshot.publicData.snapshotId,
                          ciphertext: activeSnapshot.ciphertext,
                          parentSnapshotProof:
                            activeSnapshot.publicData.parentSnapshotProof,
                        }
                      : undefined
                  );

                  break;

                case "snapshot-saved":
                  if (context.logging === "debug") {
                    console.log("snapshot saved", event);
                  }
                  // TODO test for ignoring the snapshot-saved event
                  if (
                    // Ignore snapshot-saved for an event that is not in flight
                    snapshotInFlight &&
                    event.snapshotId !==
                      snapshotInFlight.snapshot.publicData.snapshotId &&
                    // Ignore snapshot saved if there is an activeSnapshot and
                    // it doesn't match the currently active one.
                    // This can happen if another snapshot event has been received already.
                    (activeSnapshot === undefined ||
                      activeSnapshot.publicData.snapshotId ===
                        snapshotInFlight.snapshot.publicData.parentSnapshotId)
                  ) {
                    snapshotInfosWithUpdateClocks.push({
                      snapshot: snapshotInFlight.snapshot,
                      updateClocks: {},
                    });

                    // TODO test the callback
                    invokeOnDocumentUpdated("snapshot-saved");

                    snapshotInFlight = null;
                    updatesLocalClock = -1;
                  }

                  break;
                case "snapshot-save-failed":
                  if (context.logging === "debug") {
                    console.log("snapshot saving failed", event);
                  }
                  if (event.snapshot) {
                    let snapshot: Snapshot;
                    try {
                      snapshot = parseSnapshot(
                        event.snapshot,
                        context.additionalAuthenticationDataValidations
                          ?.snapshot
                      );
                    } catch (err) {
                      snapshotAndUpdateErrors.unshift(
                        new Error("SECSYNC_ERROR_110")
                      );
                      return;
                    }

                    const isAlreadyProcessedSnapshot =
                      activeSnapshot.publicData.snapshotId ===
                        snapshot.publicData.snapshotId &&
                      activeSnapshot.ciphertext === snapshot.ciphertext &&
                      activeSnapshot.publicData.parentSnapshotProof ===
                        snapshot.publicData.parentSnapshotProof;

                    if (!isAlreadyProcessedSnapshot) {
                      if (activeSnapshot) {
                        const isValid = isValidAncestorSnapshot({
                          knownSnapshotProofEntry: {
                            parentSnapshotProof:
                              activeSnapshot.publicData.parentSnapshotProof,
                            snapshotCiphertextHash: hash(
                              activeSnapshot.ciphertext,
                              context.sodium
                            ),
                            snapshotId: activeSnapshot.publicData.snapshotId,
                          },
                          snapshotProofChain: event.snapshotProofChain,
                          currentSnapshot: snapshot,
                          sodium: context.sodium,
                        });
                        if (!isValid) {
                          throw new Error(
                            "Invalid ancestor snapshot after snapshot-save-failed event"
                          );
                        }
                      }

                      await processSnapshot(snapshot);
                    }
                  }

                  if (event.updates) {
                    await processUpdates(
                      event.updates,
                      event.snapshot ? event.snapshot : activeSnapshot
                    );
                  }

                  if (context.logging === "debug") {
                    console.log("retry send snapshot");
                  }
                  await createAndSendSnapshot();
                  break;

                case "update":
                  await processUpdates([event], activeSnapshot);
                  break;
                case "update-saved":
                  if (context.logging === "debug") {
                    console.debug("update saved", event);
                  }

                  // only increases if the event.clock is larger since the server
                  // might have returned them out of order
                  snapshotInfosWithUpdateClocks = updateUpdateClocksEntry({
                    snapshotInfosWithUpdateClocks,
                    clientPublicKey: context.sodium.to_base64(
                      context.signatureKeyPair.publicKey
                    ),
                    snapshotId: event.snapshotId,
                    newClock: event.clock,
                  });
                  updatesInFlight = updatesInFlight.filter(
                    (updateInFlight) =>
                      !(
                        updateInFlight.clock === event.clock &&
                        updateInFlight.snapshotId === event.snapshotId
                      )
                  );

                  // TODO test the callback
                  invokeOnDocumentUpdated("update-saved");
                  break;
                case "update-save-failed":
                  if (context.logging === "debug") {
                    console.log(
                      "update saving failed",
                      event,
                      " referencing active snapshot: ",
                      activeSnapshot.publicData.snapshotId === event.snapshotId
                    );
                  }

                  if (event.requiresNewSnapshot) {
                    await createAndSendSnapshot();
                  } else {
                    // collect all changes that are in flight and put them back into the queue
                    const changes = updatesInFlight.reduce(
                      (acc, updateInFlight) =>
                        acc.concat(updateInFlight.changes),
                      [] as unknown[]
                    );
                    updatesInFlight = [];
                    pendingChangesQueue = changes.concat(pendingChangesQueue);

                    const currentClientPublicKey = context.sodium.to_base64(
                      context.signatureKeyPair.publicKey
                    );
                    const unverifiedCurrentClock =
                      snapshotInfosWithUpdateClocks[
                        snapshotInfosWithUpdateClocks.length - 1
                      ]?.updateClocks[currentClientPublicKey];
                    updatesLocalClock = Number.isInteger(unverifiedCurrentClock)
                      ? unverifiedCurrentClock
                      : -1;
                  }

                  break;
                case "ephemeral-message":
                  // used so we can do early return
                  const handleEphemeralMessage = async () => {
                    let ephemeralMessage: EphemeralMessage;
                    try {
                      ephemeralMessage = parseEphemeralMessage(
                        event,
                        context.additionalAuthenticationDataValidations
                          ?.ephemeralMessage
                      );
                    } catch (err) {
                      if (context.logging === "error") {
                        console.error(err);
                      }
                      ephemeralMessageReceivingErrors.unshift(
                        new Error("SECSYNC_ERROR_307")
                      );
                      return;
                    }

                    const key = await context.getSnapshotKey(activeSnapshot);

                    let isValidClient: boolean;
                    try {
                      isValidClient = await context.isValidClient(
                        ephemeralMessage.publicData.pubKey
                      );
                    } catch (err) {
                      if (context.logging === "error") {
                        console.error(err);
                      }
                      isValidClient = false;
                    }

                    if (!isValidClient) {
                      ephemeralMessageReceivingErrors.unshift(
                        new Error("SECSYNC_ERROR_304")
                      );
                      return;
                    }

                    const ephemeralMessageResult =
                      verifyAndDecryptEphemeralMessage(
                        ephemeralMessage,
                        key,
                        context.documentId,
                        context._ephemeralMessagesSession,
                        context.signatureKeyPair,
                        context.sodium,
                        context.logging
                      );

                    if (ephemeralMessageResult.error) {
                      ephemeralMessageReceivingErrors.unshift(
                        ephemeralMessageResult.error
                      );
                    }

                    if (ephemeralMessageResult.proof) {
                      send({
                        type: "ADD_EPHEMERAL_MESSAGE",
                        data: ephemeralMessageResult.proof,
                        messageType: ephemeralMessageResult.requestProof
                          ? "proofAndRequestProof"
                          : "proof",
                      });
                    }

                    if (ephemeralMessageResult.validSessions) {
                      ephemeralMessagesSession.validSessions =
                        ephemeralMessageResult.validSessions;
                    }

                    // content can be undefined if it's a new session or the
                    // session data was invalid
                    if (ephemeralMessageResult.content) {
                      context.applyEphemeralMessage(
                        ephemeralMessageResult.content,
                        ephemeralMessage.publicData.pubKey
                      );
                    }
                  };

                  await handleEphemeralMessage();
                  break;
              }
            } else if (
              context._pendingChangesQueue.length > 0 &&
              snapshotInFlight === null
            ) {
              if (documentDecryptionState !== "complete") {
                // pending changes are ignored until the document is loaded
                return {
                  handledQueue: "none",
                };
              }

              handledQueue = "pending";

              const snapshotUpdatesCount = Object.entries(
                snapshotInfosWithUpdateClocks[
                  snapshotInfosWithUpdateClocks.length - 1
                ]?.updateClocks || {}
              ).reduce((prev, curr) => {
                return prev + curr[1];
              }, 0);

              if (
                activeSnapshot === null ||
                context.shouldSendSnapshot({
                  activeSnapshotId:
                    activeSnapshot?.publicData.snapshotId || null,
                  snapshotUpdatesCount,
                })
              ) {
                if (context.logging === "debug") {
                  console.debug("send snapshot");
                }
                await createAndSendSnapshot();
              } else {
                if (context.logging === "debug") {
                  console.debug("send update");
                }
                const rawChanges = context._pendingChangesQueue;
                pendingChangesQueue = [];
                await createAndSendUpdate(
                  rawChanges,
                  activeSnapshot,
                  updatesLocalClock
                );
              }
            }

            if (errorCausingDocumentToFail) {
              throw errorCausingDocumentToFail;
            }

            return {
              handledQueue,
              snapshotInfosWithUpdateClocks,
              snapshotInFlight,
              updatesLocalClock,
              updatesInFlight,
              pendingChangesQueue,
              ephemeralMessageReceivingErrors:
                ephemeralMessageReceivingErrors.slice(0, 20), // avoid a memory leak by storing max 20 errors
              documentDecryptionState,
              ephemeralMessagesSession,
              snapshotAndUpdateErrors,
            };
          } catch (error) {
            if (context.logging === "debug" || context.logging === "error") {
              console.error("Processing queue error:", error);
            }

            // @ts-ignore fails on some environments and not in others
            error.documentDecryptionState = documentDecryptionState;
            throw error;
          }
        },
      },
      guards: {
        hasMoreItemsInQueues: (context) => {
          return (
            context._customMessageQueue.length > 0 ||
            context._incomingQueue.length > 0 ||
            context._pendingChangesQueue.length > 0
          );
        },
        shouldReconnect: (context, event) => {
          return context._websocketShouldReconnect;
        },
      },
    }
  );
