import { createSignal, For, Match, Show, Switch } from "solid-js";
import type {
  DisconnectSourceResponse,
  PublicFeed,
  PublicSource,
} from "../api/types";
import ServiceIcon from "./ServiceIcon";
import TelegramConnectPanel from "./TelegramConnectPanel";
import SubstackConnectPanel from "./SubstackConnectPanel";
import XConnectPanel from "./XConnectPanel";

type ConnectorId = "Telegram" | "Substack" | "X";

type ConnectionService = {
  connectorId: ConnectorId;
  label: string;
  description: string;
  context: string;
};

const services: ConnectionService[] = [
  {
    connectorId: "Telegram",
    label: "Telegram",
    description: "Channels and groups you choose for your daily briefing.",
    context:
      "Connect Telegram with a QR code, then choose the channels and groups to include in Sources.",
  },
  {
    connectorId: "Substack",
    label: "Substack",
    description: "Followed publications and publication URLs.",
    context:
      "Use your Substack session to discover followed publications or add a publication URL directly.",
  },
  {
    connectorId: "X",
    label: "X",
    description: "Following, Lists, and Chat conversations.",
    context:
      "Sign in through Morning Post's dedicated Chrome profile, then discover or add safe X targets.",
  },
];

interface ConnectionsPanelProps {
  sources: PublicSource[];
  feeds: PublicFeed[];
  onTelegramConnected: () => Promise<void>;
  onSubstackConnected: () => Promise<void>;
  onSubstackPublicationAdded: () => Promise<void>;
  onSubstackSourceUpdated: () => Promise<void>;
  onXConnected: () => Promise<void>;
  onXTargetAdded: (sourceId: string) => Promise<void>;
  onDisconnectSource: (id: string) => Promise<DisconnectSourceResponse>;
  onAuthError: () => void;
}

export default function ConnectionsPanel(props: ConnectionsPanelProps) {
  const [selectedConnector, setSelectedConnector] = createSignal<ConnectorId | null>(null);
  const [disconnecting, setDisconnecting] = createSignal(false);
  const [disconnectError, setDisconnectError] = createSignal<string | null>(null);
  const [disconnectNotice, setDisconnectNotice] = createSignal<string | null>(null);

  const sourceFor = (connectorId: ConnectorId) =>
    props.sources.find(
      (source) => source.connectorId === connectorId && source.connected,
    ) ?? props.sources.find((source) => source.connectorId === connectorId);

  const isConnected = (connectorId: ConnectorId) =>
    props.sources.some(
      (source) => source.connectorId === connectorId && source.connected,
    );

  const orderedServices = () =>
    [...services].sort(
      (left, right) => Number(isConnected(right.connectorId)) - Number(isConnected(left.connectorId)),
    );

  const selectedService = () =>
    services.find((service) => service.connectorId === selectedConnector());

  const connectedCount = () =>
    services.filter((service) => isConnected(service.connectorId)).length;

  const handleDisconnect = async () => {
    const connectorId = selectedConnector();
    if (!connectorId || disconnecting()) return;
    const source = sourceFor(connectorId);
    if (!source || !source.connected) return;

    setDisconnecting(true);
    setDisconnectError(null);
    setDisconnectNotice(null);
    try {
      const result = await props.onDisconnectSource(source.id);
      setDisconnectNotice(result.message);
    } catch (error: unknown) {
      if (error instanceof Error) {
        setDisconnectError(error.message);
      } else {
        setDisconnectError("The connection could not be disconnected.");
      }
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <section class="connections-page" aria-labelledby="connections-title">
      <header class="app-content-header connections-page-header">
        <div>
          <p class="app-content-kicker">Your sources</p>
          <h1 id="connections-title">Connections</h1>
          <p class="connections-page-intro">
            Connect a service first. Then choose the feeds that shape each digest.
          </p>
        </div>
        <p class="connections-summary" aria-live="polite">
          <strong>{connectedCount()}</strong> of {services.length} services connected
        </p>
      </header>

      <section aria-labelledby="connections-catalog-title">
        <div class="connections-section-heading">
          <div>
            <h2 id="connections-catalog-title">Services</h2>
            <p class="hint">Connected services appear first.</p>
          </div>
        </div>
        <div class="connections-catalog" role="list">
          <For each={orderedServices()}>
            {(service) => {
              const connected = () => isConnected(service.connectorId);
              const selected = () => selectedConnector() === service.connectorId;
              return (
                <article class="connections-service" role="listitem">
                  <button
                    type="button"
                    classList={{ selected: selected() }}
                    aria-pressed={selected()}
                    aria-controls="connection-detail"
                    onClick={() => {
                      setSelectedConnector(service.connectorId);
                      setDisconnectError(null);
                      setDisconnectNotice(null);
                    }}
                  >
                    <span class="connections-service-icon">
                      <ServiceIcon
                        connectorId={service.connectorId}
                        size={32}
                        title={service.label}
                      />
                    </span>
                    <span class="connections-service-copy">
                      <span class="connections-service-heading">
                        <strong>{service.label}</strong>
                        <span
                          class={`connections-state ${connected() ? "is-connected" : "is-disconnected"}`}
                        >
                          <span class="connections-state-icon" aria-hidden="true" />
                          {connected() ? "Connected" : "Not connected"}
                        </span>
                      </span>
                      <span class="connections-service-description">
                        {service.description}
                      </span>
                      <span class="connections-service-action">
                        {selected() ? "Selected" : connected() ? "Manage connection" : "Connect service"}
                      </span>
                    </span>
                  </button>
                </article>
              );
            }}
          </For>
        </div>
      </section>

      <Show
        when={selectedService()}
        fallback={
          <section class="connections-welcome" aria-labelledby="connections-welcome-title">
            <div>
              <p class="app-content-kicker">Start here</p>
              <h2 id="connections-welcome-title">Choose a service to continue</h2>
              <p class="hint">
                The setup for each service stays tucked away until you need it. Your connected services are ready to manage above.
              </p>
            </div>
          </section>
        }
      >
        {(service) => {
          const connectorId = () => service().connectorId;
          const connected = () => isConnected(connectorId());
          const source = () => sourceFor(connectorId());
          return (
            <section
              id="connection-detail"
              class="connections-detail"
              aria-labelledby="connection-detail-title"
            >
              <header class="connections-detail-header">
                <div class="connections-detail-heading">
                  <span class="connections-detail-icon">
                    <ServiceIcon
                      connectorId={connectorId()}
                      size={36}
                      title={service().label}
                    />
                  </span>
                  <div>
                    <p class="app-content-kicker">Selected service</p>
                    <h2 id="connection-detail-title">{service().label}</h2>
                    <p class="connections-detail-context">{service().context}</p>
                  </div>
                </div>
                <div class="connections-detail-actions">
                  <span
                    class={`connections-state connections-state-large ${connected() ? "is-connected" : "is-disconnected"}`}
                  >
                    <span class="connections-state-icon" aria-hidden="true" />
                    {connected() ? "Connected" : "Not connected"}
                  </span>
                  <Show when={connected() && source()}>
                    <button
                      type="button"
                      class="danger"
                      onClick={handleDisconnect}
                      disabled={disconnecting()}
                    >
                      {disconnecting() ? "Disconnecting…" : `Disconnect ${service().label}`}
                    </button>
                  </Show>
                </div>
              </header>

              <Show when={disconnectError()}>
                <p class="error" role="alert">{disconnectError()}</p>
              </Show>
              <Show when={disconnectNotice()}>
                <p class="connections-notice" role="status" aria-live="polite">
                  {disconnectNotice()}
                </p>
              </Show>

              <div class="connections-detail-panel">
                <Switch>
                  <Match when={connectorId() === "Telegram"}>
                    <TelegramConnectPanel
                      sources={props.sources}
                      onConnected={props.onTelegramConnected}
                      onAuthError={props.onAuthError}
                    />
                  </Match>
                  <Match when={connectorId() === "Substack"}>
                    <SubstackConnectPanel
                      sources={props.sources}
                      feeds={props.feeds}
                      onConnected={props.onSubstackConnected}
                      onPublicationAdded={props.onSubstackPublicationAdded}
                      onSourceUpdated={props.onSubstackSourceUpdated}
                      onAuthError={props.onAuthError}
                    />
                  </Match>
                  <Match when={connectorId() === "X"}>
                    <XConnectPanel
                      sources={props.sources}
                      feeds={props.feeds}
                      onConnected={props.onXConnected}
                      onTargetAdded={props.onXTargetAdded}
                      onAuthError={props.onAuthError}
                    />
                  </Match>
                </Switch>
              </div>
            </section>
          );
        }}
      </Show>
    </section>
  );
}
