import { createSignal, Show } from "solid-js";
import type { PublicUser } from "../api/types";
import { ApiClientError } from "../api/client";

interface ProfilePanelProps {
  user: PublicUser;
  onSave: (input: {
    name?: string;
    systemPrompt?: string;
    defaultLanguage?: string | null;
    defaultModel?: string | null;
  }) => Promise<PublicUser>;
  onSaved: (user: PublicUser) => void;
  onAuthError: () => void;
}

export default function ProfilePanel(props: ProfilePanelProps) {
  const [name, setName] = createSignal(props.user.name);
  const [systemPrompt, setSystemPrompt] = createSignal(props.user.systemPrompt);
  const [defaultLanguage, setDefaultLanguage] = createSignal(
    props.user.defaultLanguage ?? "",
  );
  const [defaultModel, setDefaultModel] = createSignal(
    props.user.defaultModel ?? "",
  );
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);

    try {
      const updatedUser = await props.onSave({
        name: name(),
        systemPrompt: systemPrompt(),
        defaultLanguage: defaultLanguage().trim() === ""
          ? null
          : defaultLanguage(),
        defaultModel: defaultModel().trim() === "" ? null : defaultModel(),
      });
      props.onSaved(updatedUser);
      setSaved(true);
    } catch (err: unknown) {
      if (err instanceof ApiClientError && err.status === 401) {
        props.onAuthError();
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("An unexpected error occurred");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="card">
      <div class="card-header">
        <h2>Profile</h2>
      </div>
      <form onSubmit={handleSubmit}>
        <div class="form-group">
          <label for="profile-name">Name</label>
          <input
            id="profile-name"
            type="text"
            required
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </div>
        <div class="form-row">
          <div class="form-group">
            <label for="profile-language">Default language</label>
            <input
              id="profile-language"
              type="text"
              value={defaultLanguage()}
              onInput={(e) => setDefaultLanguage(e.currentTarget.value)}
            />
            <div class="hint">
              e.g. English, Spanish. Leave blank for auto-detection.
            </div>
          </div>
          <div class="form-group">
            <label for="profile-model">Default model</label>
            <input
              id="profile-model"
              type="text"
              value={defaultModel()}
              onInput={(e) => setDefaultModel(e.currentTarget.value)}
            />
            <div class="hint">
              AI model for summarization. Leave blank for default.
            </div>
          </div>
        </div>
        <div class="form-group">
          <label for="profile-prompt">System prompt</label>
          <textarea
            id="profile-prompt"
            rows={4}
            value={systemPrompt()}
            onInput={(e) => setSystemPrompt(e.currentTarget.value)}
          />
        </div>
        <Show when={error()}>
          <div class="error">{error()}</div>
        </Show>
        <Show when={saved()}>
          <div class="hint">Profile saved</div>
        </Show>
        <div class="form-actions">
          <button type="submit" class="primary" disabled={saving()}>
            {saving() ? "Saving…" : "Save profile"}
          </button>
        </div>
      </form>
    </div>
  );
}
