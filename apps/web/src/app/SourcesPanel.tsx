import { createSignal, For, Show } from "solid-js";
import type { PublicSource, AvailableFeed } from "../api/types";

interface SourcesPanelProps {
  sources: PublicSource[];
  onToggleSource: (id: string, enabled: boolean) => Promise<void>;
  onDiscoverFeeds: (sourceId: string) => Promise<AvailableFeed[]>;
  onAuthError: () => void;
}

export default function SourcesPanel(props: SourcesPanelProps) {
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const [discovering, setDiscovering] = createSignal<Record<string, boolean>>({});

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await props.onToggleSource(id, enabled);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "status" in err &&
        (err as { status: number }).status === 401
      ) {
        props.onAuthError();
      }
    }
  };

  const handleDiscover = async (sourceId: string) => {
    setDiscovering((d) => ({ ...d, [sourceId]: true }));
    setErrors((e) => {
      const next = { ...e };
      delete next[sourceId];
      return next;
    });

    try {
      await props.onDiscoverFeeds(sourceId);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "status" in err &&
        (err as { status: number }).status === 401
      ) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setErrors((e) => ({ ...e, [sourceId]: err.message }));
      }
    } finally {
      setDiscovering((d) => {
        const next = { ...d };
        delete next[sourceId];
        return next;
      });
    }
  };

  return (
    <div class="card">
      <div class="card-header">
        <h2>Sources</h2>
      </div>
      <Show
        when={props.sources.length > 0}
        fallback={
          <p class="hint">
            Connectors are available through the existing Telegram login API;
            this screen displays connected sources once they exist.
          </p>
        }
      >
        <For each={props.sources}>
          {(source) => (
            <div class="card" style="margin-bottom: 0.75rem;">
              <div class="meta-row">
                <dt>Connector</dt>
                <dd>{source.connectorId}</dd>
              </div>
              <div class="meta-row">
                <dt>Enabled</dt>
                <dd>
                  <label class="toggle">
                    <input
                      type="checkbox"
                      checked={source.enabled}
                      onChange={(e) =>
                        handleToggle(source.id, e.currentTarget.checked)
                      }
                    />
                    <span>{source.enabled ? "On" : "Off"}</span>
                  </label>
                </dd>
              </div>
              <div class="meta-row">
                <dt>Position</dt>
                <dd>{source.position}</dd>
              </div>
              <div style="margin-top: 0.5rem;">
                <button
                  onClick={() => handleDiscover(source.id)}
                  disabled={discovering()[source.id]}
                >
                  {discovering()[source.id] ? "Discovering…" : "Discover feeds"}
                </button>
              </div>
              <Show when={errors()[source.id]}>
                <div class="error" style="margin-top: 0.5rem;">
                  {errors()[source.id]}
                </div>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}
