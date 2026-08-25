import {
  connectedClientIds,
  disconnectedClientIds,
  localClientID,
  pendingCreatorChanges,
  pendingJoins,
  pendingMessages,
  pendingParts
} from "../bit-systems/networking";
import { EntityState } from "./entity-state-utils";
import type { ClientID, CreatorChange, Message } from "./networking-types";

type Emitter = {
  on: (event: string, callback: (a: any) => any) => number;
  off: (event: string, ref: number) => void;
  trigger: (event: string, payload: any) => void;
  getBindings: () => any[];
};
type PhoenixChannel = any;

export function listenForNetworkMessages(channel: PhoenixChannel, presenceEventEmitter: Emitter) {
  presenceEventEmitter.on("hub:join", onJoin);
  presenceEventEmitter.on("hub:leave", onLeave);
  channel.on("naf", onNaf);
  channel.on("nafr", onNafr);
  channel.on("entity_state_saved", onEntityStateCreated);
  channel.on("entity_state_updated", onEntityStateUpdated);
  channel.on("entity_state_deleted", onEntityStateDeleted);
}

function onJoin({ key }: { key: ClientID }) {
  const clientId = APP.getSid(key);
  if (clientId !== localClientID!) {
    pendingJoins.push(clientId);
    connectedClientIds.add(clientId);
    disconnectedClientIds.delete(clientId); // In case of reconnect
  }
}

function onLeave({ key }: { key: ClientID }) {
  const clientId = APP.getSid(key);
  if (clientId !== localClientID!) {
    pendingParts.push(clientId);
    connectedClientIds.delete(clientId);
    disconnectedClientIds.add(clientId);
  }
}

type NafMessage = {
  from_session_id: string;
  data: any;
  dataType: string;
  source: string;
};
function onNaf(message: NafMessage) {
  const { from_session_id, data, dataType } = message;
  if (dataType == "nn") {
    (data as Message).fromClientId = from_session_id;
    pendingMessages.push(data);
  } else if (dataType == "u" || dataType == "r") {
    bufferLegacyNaf(message);
  }
}

// Legacy NAF traffic starts the moment we appear in presence: every client in the room
// answers our join with the first syncs that instantiate their avatars. But PhoenixAdapter
// binds its channel handlers only when the scene connects, and Phoenix drops events nobody
// is bound to, so everything landing in that window used to be lost. Clients on a visible
// tab papered over it by re-broadcasting every few seconds (periodic-full-syncs), but a
// hidden tab has no animation loop and never re-sends — that avatar then never appeared,
// and with it went the positional audio, while presence kept listing the person.
// This module IS bound before join, so it stashes that window ("u" instantiates and "r"
// deletes; "um" can only update entities that already exist, so it has nothing to say
// here) until the adapter connects and drains it.
const MAX_PENDING_LEGACY_MESSAGES = 500;
const pendingLegacyMessages: NafMessage[] = [];
let legacyAdapter: { handleIncomingNAF: (message: NafMessage) => void } | null = null;

function bufferLegacyNaf(message: NafMessage) {
  // A live adapter has its own binding on this channel and already received this event.
  if (legacyAdapter) return;
  pendingLegacyMessages.push(message);
  if (pendingLegacyMessages.length > MAX_PENDING_LEGACY_MESSAGES) pendingLegacyMessages.shift();
}

export function drainLegacyNafMessages(adapter: { handleIncomingNAF: (message: NafMessage) => void }) {
  legacyAdapter = adapter;
  pendingLegacyMessages.splice(0).forEach(message => adapter.handleIncomingNAF(message));
}

export function releaseLegacyNafDrain() {
  legacyAdapter = null;
}

type NafrMessage = {
  from_session_id: string;
  naf: string;
  parsed?: NafMessage;
};
function onNafr(message: NafrMessage) {
  const { from_session_id, naf: unparsedData } = message;
  // Attach the parsed JSON to the message so that
  // PhoenixAdapter can process it without parsing it again.
  message.parsed = JSON.parse(unparsedData);
  message.parsed!.from_session_id = from_session_id;
  onNaf(message.parsed!);
}

export function queueEntityStateAsMessage(entityState: EntityState) {
  const rootNid = entityState.create_message.networkId;
  entityState.update_messages.forEach(update => {
    update.owner = "reticulum";
  });
  pendingMessages.push({
    fromClientId: "reticulum",
    creates: [entityState.create_message],
    updates: entityState.update_messages,
    deletes: []
  });
  pendingCreatorChanges.push({
    nid: rootNid,
    creator: "reticulum"
  });
}

function onEntityStateCreated(response: { data: EntityState[] }) {
  // console.log("entity_state_saved", response);
  queueEntityStateAsMessage(response.data[0]!);
}

function onEntityStateUpdated(_response: any) {
  // console.log("entity_state_updated", response);
}

function onEntityStateDeleted(response: CreatorChange) {
  // console.log("entity_state_deleted", response);
  pendingCreatorChanges.push(response);
}
