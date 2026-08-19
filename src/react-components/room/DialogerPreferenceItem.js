import React, { useCallback, useState } from "react";
import { FormattedMessage } from "react-intl";

/**
 * Settings row for the Dialoger integration.
 *
 * A custom component rather than one of the usual preference rows because the
 * preferences screen has no free-text item type — only checkboxes, selects and
 * numeric ranges — and this needs a URL and a token.
 *
 * The values live in `store.state.preferences`, so they are local to this
 * browser profile and never travel over presence.
 */
export function DialogerPreferenceItem() {
  const store = window.APP.store;
  const prefs = store.state.preferences || {};
  const [url, setUrl] = useState(prefs.dialogerUrl || "http://127.0.0.1:8765");
  const [token, setToken] = useState(prefs.dialogerToken || "");
  const [checked, setChecked] = useState(null);

  const save = useCallback(patch => store.update({ preferences: patch }), [store]);

  const check = useCallback(async () => {
    setChecked("checking");
    try {
      // Same-origin from Dialoger's point of view, but cross-origin from here:
      // without CORS we cannot read the body, so all we learn is whether it
      // answered at all. That is enough to tell "running" from "not running".
      await fetch(`${url.replace(/\/$/, "")}/api/office/config`, { mode: "no-cors" });
      setChecked("ok");
    } catch {
      setChecked("fail");
    }
  }, [url]);

  const row = { display: "flex", gap: "8px", alignItems: "center", marginBottom: "6px" };
  const input = { flex: 1, minWidth: 0, padding: "6px 8px" };

  return (
    <div style={{ width: "100%", padding: "6px 0" }}>
      <label style={row}>
        <input
          type="checkbox"
          checked={!!prefs.dialogerEnabled}
          onChange={e => save({ dialogerEnabled: e.target.checked })}
        />
        <span>
          <FormattedMessage id="dialoger.enable" defaultMessage="Record meetings to Dialoger" />
        </span>
      </label>

      <div style={{ opacity: prefs.dialogerEnabled ? 1 : 0.5 }}>
        <div style={row}>
          <span style={{ width: "60px" }}>
            <FormattedMessage id="dialoger.url" defaultMessage="Address" />
          </span>
          <input
            style={input}
            type="text"
            value={url}
            disabled={!prefs.dialogerEnabled}
            onChange={e => setUrl(e.target.value)}
            onBlur={() => save({ dialogerUrl: url.trim() })}
          />
        </div>
        <div style={row}>
          <span style={{ width: "60px" }}>
            <FormattedMessage id="dialoger.token" defaultMessage="Token" />
          </span>
          <input
            style={input}
            type="password"
            value={token}
            placeholder="/api/office/token"
            disabled={!prefs.dialogerEnabled}
            onChange={e => setToken(e.target.value)}
            onBlur={() => save({ dialogerToken: token.trim() })}
          />
        </div>
        <div style={row}>
          <button type="button" onClick={check} disabled={!prefs.dialogerEnabled}>
            <FormattedMessage id="dialoger.check" defaultMessage="Check" />
          </button>
          <span>
            {checked === "checking" && <FormattedMessage id="dialoger.checking" defaultMessage="checking…" />}
            {checked === "ok" && <FormattedMessage id="dialoger.check-ok" defaultMessage="Dialoger responds" />}
            {checked === "fail" && (
              <FormattedMessage id="dialoger.check-fail" defaultMessage="no answer — is it running?" />
            )}
          </span>
        </div>
        <div style={{ fontSize: "12px", opacity: 0.7 }}>
          <FormattedMessage
            id="dialoger.hint"
            defaultMessage="Recording runs on this machine. While it does, your name tag shows a red badge and the bridge window must stay open."
          />
        </div>
      </div>
    </div>
  );
}
