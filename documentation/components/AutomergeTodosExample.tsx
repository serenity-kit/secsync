import type { Doc } from "@automerge/automerge";
import * as Automerge from "@automerge/automerge";
import { KeyPair, default as sodium } from "libsodium-wrappers";
import React, { useState } from "react";
import { useAutomergeSync } from "secsync-react-automerge";
import { DevTool } from "secsync-react-devtool";
import { v4 as uuidv4 } from "uuid";

type TodoType = {
  value: string;
  completed: boolean;
  createdAt: number;
};

type Todos = { todos: { [key: string]: TodoType } };

const websocketEndpoint =
  process.env.NODE_ENV === "development"
    ? "ws://localhost:4000"
    : "wss://secsync.fly.dev";

type Props = {
  documentId: string;
  documentKey: Uint8Array;
};

const AutomergeTodosExample: React.FC<Props> = ({
  documentId,
  documentKey,
}) => {
  const [newTodo, setNewTodo] = React.useState("");
  const [initialDoc] = useState<Doc<Todos>>(() => Automerge.init());
  const [authorKeyPair] = useState<KeyPair>(() => {
    return sodium.crypto_sign_keypair();
  });

  const [currentDoc, syncDoc, state, send] = useAutomergeSync<Todos>({
    initialDoc,
    documentId: documentId,
    signatureKeyPair: authorKeyPair,
    websocketEndpoint,
    websocketSessionKey: "your-secret-session-key",
    onDocumentUpdated: async ({ knownSnapshotInfo }) => {},
    getNewSnapshotData: async ({ id }) => {
      const docState: Uint8Array = Automerge.save(currentDoc);
      return {
        data: docState,
        key: documentKey,
        publicData: {},
      };
    },
    getSnapshotKey: async (snapshot) => {
      return documentKey;
    },
    shouldSendSnapshot: ({ snapshotUpdatesCount }) => {
      // create a new snapshot if the active snapshot has more than 100 updates
      return snapshotUpdatesCount > 100;
    },
    isValidClient: (signingPublicKey) => {
      return true;
    },
    sodium,
    logging: "debug",
  });

  return (
    <>
      <div className="todoapp">
        <form
          onSubmit={(event) => {
            event.preventDefault();

            const newDoc: Doc<Todos> = Automerge.change(currentDoc, (doc) => {
              if (!doc.todos) doc.todos = {};
              const id = uuidv4();
              doc.todos[id] = {
                value: newTodo,
                completed: false,
                createdAt: new Date().getTime(),
              };
            });
            syncDoc(newDoc);
            setNewTodo("");
          }}
        >
          <input
            placeholder="What needs to be done?"
            onChange={(event) => setNewTodo(event.target.value)}
            value={newTodo}
            className="new-todo"
          />
          <button className="add">Add</button>
        </form>
        <ul className="todo-list">
          {currentDoc.todos &&
            Object.keys(currentDoc.todos)
              .map((id) => {
                return {
                  ...currentDoc.todos[id],
                  id,
                };
              })
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((todo) => (
                <li key={todo.id}>
                  <input
                    className="edit"
                    onChange={(event) => {
                      const newDoc: Doc<Todos> = Automerge.change(
                        currentDoc,
                        (doc) => {
                          doc.todos[todo.id].value = event.target.value;
                        }
                      );
                      syncDoc(newDoc);
                    }}
                    value={todo.value}
                  />
                  <input
                    className="toggle"
                    type="checkbox"
                    checked={todo.completed}
                    onChange={(event) => {
                      const newDoc: Doc<Todos> = Automerge.change(
                        currentDoc,
                        (doc) => {
                          doc.todos[todo.id].completed = event.target.checked;
                        }
                      );
                      syncDoc(newDoc);
                    }}
                  />
                  <button
                    className="destroy"
                    type="button"
                    onClick={(event) => {
                      event.preventDefault();
                      const newDoc: Doc<Todos> = Automerge.change(
                        currentDoc,
                        (doc) => {
                          delete doc.todos[todo.id];
                        }
                      );
                      syncDoc(newDoc);
                    }}
                  ></button>
                </li>
              ))}
        </ul>
      </div>

      <div className="mt-8" />
      <DevTool state={state} send={send} />
    </>
  );
};

export default AutomergeTodosExample;
